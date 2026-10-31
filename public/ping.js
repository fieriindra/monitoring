// Modul Ping: form perangkat SSH + terminal realtime (WebSocket /ws/ping).
(function () {
  "use strict";

  const PRESETS = {
    // 3 paket, jeda kirim 200 ms, timeout tunggu balasan 1000 ms per paket (-t).
    // Satu paket saja (-c 1) terlalu mudah berayun: satu balasan hilang sesaat
    // langsung terbaca RTO. Dengan 3 paket, RTO hanya bila ketiganya tak berbalas,
    // dan latency diambil dari rata-rata statistik akhir perangkat.
    // Catatan: di VRP, -m adalah jeda ANTAR paket, bukan timeout balasan.
    HUAWEI: "ping -c 3 -m 200 -t 1000 <IP>",
    JUNIPER: "ping count 1 wait 1 <IP>",
    MIKROTIK: "/ping count=1 interval=1s <IP>"
  };
  const MAX_TARGETS_PER_DEVICE = 6;
  const MAX_LINES = 60;
  const RECONNECT_MS = 3000;

  let socket = null;
  let displayActive = false;
  let reconnectTimer = null;
  let cells = new Map();

  function clock(value) {
    return new Date(value).toLocaleTimeString("en-GB", { hour12: false });
  }

  function indicator(state) {
    const element = document.getElementById("conn-state");
    if (!element) return;
    element.className = `conn ${state === "on" ? "on" : state === "off" ? "off" : ""}`;
    element.lastChild.textContent = state === "on" ? "LIVE" : state === "off" ? "TERPUTUS" : "MENYAMBUNG";
  }

  function appendLine(entry, data, kind) {
    const line = document.createElement("div");
    line.className = `line ${kind}`;
    const time = document.createElement("span");
    time.className = "t";
    time.textContent = `[${clock(data.created_at || Date.now())}] `;
    let text = data.line;
    if (kind !== "sys" && data.status === "UP" && data.latency != null) {
      text = text
        .replace(/\btime\s*[=<]\s*\d+(?:\.\d+)?\s*ms\b/gi, "")
        .replace(/\b\d+(?:\.\d+)?ms(?:\d+us)?\b/gi, "")
        .replace(/\b\d+us\b/gi, "")
        .replace(/\s+/g, " ")
        .replace(/[:|,;]\s*$/, "")
        .trim();
      text += `${text ? "  | " : ""}${data.latency} ms`;
    } else if (kind === "timeout") {
      text = data.target ? `0 ${data.target} timeout` : "0 timeout";
    }
    line.append(time, document.createTextNode(text));
    entry.term.appendChild(line);
    while (entry.term.childElementCount > MAX_LINES) entry.term.firstElementChild.remove();
  }

  // Kolom diidentifikasi oleh perangkat + target (null bila perangkat tanpa target khusus).
  function cellKey(deviceId, target) {
    return target ? `${deviceId}:${target}` : `${deviceId}`;
  }

  function applyResult(data) {
    const entry = cells.get(cellKey(data.device_id, data.target));
    if (!entry) return;
    const up = data.status === "UP";
    appendLine(entry, data, up ? "up" : "timeout");
    entry.cell.classList.toggle("up", up);
    entry.cell.classList.toggle("timeout", !up);
  }

  // Satu slot/kolom per (perangkat, tujuan), diurutkan berdasarkan slot_order target (ping_targets.position).
  function expandColumns(devices) {
    const columns = [];
    for (const device of devices) {
      const targetItems = device.target_items && device.target_items.length
        ? device.target_items
        : (device.targets && device.targets.length
            ? device.targets.map((target, index) => ({ id: null, target, label: null, slot_order: index + 1 }))
            : [{ id: null, target: null, label: null, slot_order: device.slot_order || 1 }]);
      for (const item of targetItems) {
        columns.push({
          id: item.id,
          slot_order: item.slot_order,
          label: item.label || null,
          device,
          target: item.target
        });
      }
    }
    columns.sort((a, b) => (a.slot_order - b.slot_order) || (a.device.slot_order - b.device.slot_order) || ((a.id || 0) - (b.id || 0)));
    return columns;
  }

  // columns di sini sudah berupa unit per-slot (hasil expand), bukan daftar perangkat mentah.
  function buildGrid(grid, columns, capacity) {
    grid.replaceChildren();
    cells = new Map();
    for (let index = 0; index < capacity; index += 1) {
      const column = columns[index];
      const cell = document.createElement("div");
      if (!column) {
        cell.className = "cell empty";
        cell.textContent = `SLOT ${index + 1} KOSONG`;
        grid.appendChild(cell);
        continue;
      }
      const { device, target, label } = column;
      const displayLabel = (label && label.trim()) || device.label;
      cell.className = "cell";
      const head = document.createElement("div");
      head.className = "cell-head";
      const dot = document.createElement("span");
      dot.className = "dot";
      const title = document.createElement("span");
      title.className = "title";
      title.textContent = target ? `${displayLabel} → ${target}` : displayLabel;
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = `${device.device_type} ${device.host}`;
      head.append(dot, title, meta);
      const term = document.createElement("div");
      term.className = "term";
      cell.append(head, term);
      grid.appendChild(cell);
      cells.set(cellKey(device.id, target), { cell, term });
    }
  }

  function connect() {
    if (!displayActive) return;
    indicator("connecting");
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${scheme}://${window.location.host}/ws/ping`);
    socket.addEventListener("open", () => indicator("on"));
    socket.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "ping") applyResult(data);
      } catch { /* abaikan pesan rusak */ }
    });
    socket.addEventListener("close", () => {
      indicator("off");
      if (displayActive) reconnectTimer = setTimeout(connect, RECONNECT_MS);
    });
  }

  // columns: unit per-slot hasil Monitor.expand() (satu entri per device+target), sudah dipotong per slide.
  async function startDisplay(grid, columns, capacity) {
    displayActive = true;
    buildGrid(grid, columns, capacity);
    try {
      const recent = await Monitor.api("/api/ping/recent?limit=30");
      if (!displayActive) return;
      for (const [key, rows] of Object.entries(recent)) {
        const entry = cells.get(key);
        if (!entry) continue;
        // Target boleh berisi ":" (mis. IPv6); device_id selalu prefix numerik sebelum ":" pertama.
        const separator = key.indexOf(":");
        const deviceId = Number(separator < 0 ? key : key.slice(0, separator));
        const target = separator < 0 ? null : key.slice(separator + 1);
        rows.forEach((row) => applyResult({ device_id: deviceId, target, ...row }));
      }
    } catch (error) {
      Monitor.toast(error.message, "err");
    }
    connect();
  }

  function stopDisplay() {
    displayActive = false;
    clearTimeout(reconnectTimer);
    if (socket) {
      socket.close();
      socket = null;
    }
  }

  function initForm(form) {
    const type = form.elements.device_type;
    const command = form.elements.ping_command;
    const srcWrap = document.getElementById("f-src-wrap");
    let edited = false;

    const applyPreset = () => {
      command.value = PRESETS[type.value];
      edited = false;
    };
    const toggleSrc = () => {
      if (srcWrap) srcWrap.style.display = type.value === "MIKROTIK" ? "" : "none";
    };
    type.addEventListener("change", () => { if (!edited) applyPreset(); toggleSrc(); });
    command.addEventListener("input", () => { edited = true; });
    document.getElementById("reset-preset").addEventListener("click", applyPreset);
    form.addEventListener("reset", () => setTimeout(() => { applyPreset(); toggleSrc(); }));
    applyPreset();
    toggleSrc();
  }

  // Isi ulang form TAMBAH dengan data perangkat yang mau diedit (dipanggil oleh monitor.js).
  function populateForm(form, item) {
    form.elements.label.value = item.label;
    form.elements.device_type.value = item.device_type;
    form.elements.host.value = item.host;
    form.elements.port.value = item.port;
    form.elements.username.value = item.username;
    form.elements.password.value = "";
    const targetLines = (item.target_items && item.target_items.length)
      ? item.target_items
          .filter((t) => t.target)
          .map((t) => (t.label && t.label !== item.label ? `${t.target} | ${t.label}` : t.target))
      : (item.targets || []);
    form.elements.targets.value = targetLines.join("\n");
    form.elements.ping_command.value = item.ping_command;
    form.elements.src_address.value = item.src_address || "";
    const srcWrap = document.getElementById("f-src-wrap");
    if (srcWrap) srcWrap.style.display = item.device_type === "MIKROTIK" ? "" : "none";
  }

  function parseTargetLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;
    if (!trimmed.includes("|")) return { target: trimmed, label: null };
    const [partA, ...rest] = trimmed.split("|");
    const a = partA.trim();
    const b = rest.join("|").trim();
    const ipLike = /^[A-Za-z0-9.:-]+$/;
    if (ipLike.test(a) && (!ipLike.test(b) || /^\d/.test(a))) {
      return { target: a, label: b || null };
    }
    return { target: b, label: a || null };
  }

  function buildPayload(form, isEdit) {
    const field = (name) => form.elements[name].value;
    const password = field("password");
    if (!isEdit && !password) throw new Error("Password SSH wajib diisi.");
    const command = field("ping_command").trim();
    const rawLines = field("targets").split(/\r?\n/).map(parseTargetLine).filter(Boolean);
    if (rawLines.length > MAX_TARGETS_PER_DEVICE) {
      throw new Error(`Maksimal ${MAX_TARGETS_PER_DEVICE} tujuan per perangkat.`);
    }
    for (const entry of rawLines) {
      if (!/^[A-Za-z0-9.:-]{1,100}$/.test(entry.target)) {
        throw new Error(`Target "${entry.target}" hanya boleh berisi huruf, angka, titik, titik dua, dan strip.`);
      }
      if (entry.label && entry.label.length > 100) {
        throw new Error(`Nama kolom "${entry.label}" maksimal 100 karakter.`);
      }
    }
    if (rawLines.length && !command.includes("<IP>")) {
      throw new Error("Ping command harus memuat placeholder <IP> ketika mengisi daftar tujuan.");
    }
    if (!rawLines.length && command.includes("<IP>")) {
      throw new Error("Isi minimal satu Target, karena command memakai placeholder <IP>.");
    }
    return {
      label: field("label"),
      host: field("host"),
      port: field("port") || 22,
      username: field("username"),
      password,
      device_type: field("device_type"),
      ping_command: command,
      src_address: field("src_address").trim(),
      targets: rawLines
    };
  }

  Monitor.register({
    endpoint: "/api/ping/devices",
    noun: "perangkat",
    counterText: (devices, slots) => `${devices.length} perangkat · ${slots} tujuan ping terdaftar`,
    cardInfo: (unit) => {
      const device = unit.device || unit;
      const target = unit.target !== undefined ? unit.target : null;
      const displayLabel = (unit.label && unit.label.trim()) || device.label;
      return {
        title: target ? `${displayLabel} → ${target}` : displayLabel,
        editableLabel: displayLabel,
        defaultLabel: device.label,
        sub: `${target ? `→ ${target} · ` : ""}${device.device_type} ${device.host}`
      };
    },
    deleteEndpoint: (unit) => unit.id ? `/api/ping/targets/${unit.id}` : `/api/ping/devices/${(unit.device || unit).id}`,
    confirmDelete: (unit, info) => {
      const device = unit.device || unit;
      const count = (device.target_items && device.target_items.length) || (device.targets && device.targets.length) || 1;
      if (count <= 1) {
        return `Hapus "${info.title}"? Karena ini tujuan terakhir pada perangkat "${device.label}", perangkat juga akan dihapus dari MySQL.`;
      }
      return `Hapus tujuan "${unit.target}" dari perangkat "${device.label}"?`;
    },
    initForm,
    populateForm,
    buildPayload,
    expand: expandColumns,
    startDisplay,
    stopDisplay
  });
})();
