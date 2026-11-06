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
    // Sama seperti Huawei: 3 paket agar satu paket hilang sesaat tidak langsung
    // terbaca RTO, dan latency diambil dari rata-rata statistik akhir.
    // Juniper: "wait" adalah jeda tunggu SETELAH paket terakhir terkirim
    // (default 10 detik), jadi diisi 1; total run +/- 3 detik.
    JUNIPER: "ping count 3 interval 1 wait 1 <IP>",
    // MikroTik: di RouterOS, interval sekaligus menjadi jendela timeout tiap
    // paket — interval 1 detik memberi ruang untuk target dengan RTT besar,
    // dan 3 paket selesai dalam +/- 3 detik.
    MIKROTIK: "/ping count=3 interval=1s <IP>"
  };
  const MAX_TARGETS_PER_DEVICE = 6;
  const MAX_LINES = 60;
  const RECONNECT_MS = 3000;

  let socket = null;
  let displayActive = false;
  let reconnectTimer = null;
  // Penomoran generasi startDisplay: pemanggilan yang lebih baru membatalkan
  // pemanggilan lama yang fetch riwayatnya belum selesai (lihat startDisplay).
  let displayGeneration = 0;
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
    clearTimeout(reconnectTimer);
    indicator("connecting");
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${scheme}://${window.location.host}/ws/ping`);
    socket = ws;
    ws.addEventListener("open", () => {
      if (socket === ws) indicator("on");
    });
    ws.addEventListener("message", (event) => {
      if (socket !== ws) return;
      try {
        const data = JSON.parse(event.data);
        if (data.type === "ping") applyResult(data);
      } catch { /* abaikan pesan rusak */ }
    });
    ws.addEventListener("close", () => {
      // Hanya socket yang masih tercatat aktif yang boleh menjadwalkan
      // sambung ulang. Event close dari socket LAMA tiba belakangan — setelah
      // stopDisplay menutupnya dan startDisplay sudah membuat socket baru
      // serta menandai displayActive=true — sehingga tanpa penjaga ini
      // setiap ganti slide/restart tampilan menambah satu socket hidup, dan
      // setiap hasil ping digambar berulang sebanyak socket yang menumpuk.
      if (socket !== ws) return;
      socket = null;
      indicator("off");
      if (displayActive) reconnectTimer = setTimeout(connect, RECONNECT_MS);
    });
  }

  // columns: unit per-slot hasil Monitor.expand() (satu entri per device+target), sudah dipotong per slide.
  async function startDisplay(grid, columns, capacity) {
    // startDisplay bisa tumpang tindih: panggilan berikutnya (ganti slide,
    // route ulang, tab yang dibekukan lalu dipulihkan) dapat mulai saat fetch
    // riwayat panggilan ini belum selesai. Tanpa penjaga generasi, panggilan
    // lama ikut menggambar riwayatnya ke sel yang baru (baris tampil ganda)
    // dan ikut membuka socket. Generasi memastikan hanya panggilan terakhir
    // yang menggambar dan menyambung.
    const generation = ++displayGeneration;
    displayActive = true;
    buildGrid(grid, columns, capacity);
    try {
      const recent = await Monitor.api("/api/ping/recent?limit=30");
      if (!displayActive || generation !== displayGeneration) return;
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
      if (generation === displayGeneration) Monitor.toast(error.message, "err");
      return;
    }
    if (!displayActive || generation !== displayGeneration) return;
    connect();
  }

  function stopDisplay() {
    displayGeneration += 1;
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
          .map((t) => {
            const base = t.label && t.label !== item.label ? `${t.target} | ${t.label}` : t.target;
            return t.logical_system ? `${base} | ls=${t.logical_system}` : base;
          })
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
    // Segmen "ls=NAMA" (khusus Juniper) diarahkan ke logical-system; segmen
    // lain adalah IP dan nama kolom seperti sebelumnya.
    let logicalSystem = null;
    const rest = [];
    for (const segment of trimmed.split("|").map((part) => part.trim())) {
      const lsMatch = segment.match(/^ls=(.+)$/i);
      if (lsMatch) logicalSystem = lsMatch[1].trim();
      else if (segment) rest.push(segment);
    }
    if (!rest.length) return null;
    if (rest.length === 1) return { target: rest[0], label: null, logical_system: logicalSystem };
    const a = rest[0];
    const b = rest.slice(1).join("|");
    const ipLike = /^[A-Za-z0-9.:-]+$/;
    if (ipLike.test(a) && (!ipLike.test(b) || /^\d/.test(a))) {
      return { target: a, label: b || null, logical_system: logicalSystem };
    }
    return { target: b, label: a || null, logical_system: logicalSystem };
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
      if (entry.logical_system && !/^[A-Za-z0-9._-]{1,64}$/.test(entry.logical_system)) {
        throw new Error(`Logical system "${entry.logical_system}" hanya boleh berisi huruf, angka, titik, strip, dan garis bawah (maksimal 64 karakter).`);
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

  /* ---------- Log Timeout / RTO ---------- */
  // Daftar kejadian RTO berurutan dari /api/ping/timeout-logs + ambang
  // pencatatannya dari /api/ping/timeout-settings (default 3 detik).

  function formatDateTime(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleString("id-ID", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    });
  }

  function formatDuration(totalSeconds) {
    if (totalSeconds == null) return "—";
    const seconds = Math.max(0, Math.round(totalSeconds));
    if (seconds < 60) return `${seconds} dtk`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return seconds % 60 ? `${minutes} mnt ${seconds % 60} dtk` : `${minutes} mnt`;
    const hours = Math.floor(minutes / 60);
    return minutes % 60 ? `${hours} jam ${minutes % 60} mnt` : `${hours} jam`;
  }

  function initTimeoutLog() {
    const body = document.getElementById("timeout-log-body");
    if (!body) return;
    const thresholdInput = document.getElementById("f-timeout-threshold");
    const saveButton = document.getElementById("save-timeout-threshold");
    const refreshButton = document.getElementById("refresh-timeout-log");
    let settingsLoaded = false;
    let expandedId = null;
    // Cache detail kejadian yang SUDAH PULIH: isinya tidak akan berubah,
    // jadi membuka ulang / menggambar ulang tidak perlu memuat dari API lagi.
    const detailCache = new Map();
    // Tanda tangan daftar terakhir yang digambar; dipakai penyegaran berkala
    // untuk melewati penggambaran ulang bila tidak ada yang berubah.
    let lastSignature = "";

    function cell(text, sub) {
      const td = document.createElement("td");
      td.textContent = text;
      if (sub) {
        const small = document.createElement("span");
        small.className = "sub";
        small.textContent = sub;
        td.appendChild(small);
      }
      return td;
    }

    function renderRows(rows) {
      body.replaceChildren();
      if (!rows.length) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 7;
        td.className = "log-empty";
        td.textContent = "Belum ada log timeout. Kejadian RTO berurutan yang mencapai ambang akan muncul di sini.";
        tr.appendChild(td);
        body.appendChild(tr);
        return;
      }
      for (const row of rows) {
        const tr = document.createElement("tr");
        const ongoing = row.state === "ongoing";
        tr.className = `log-row${row.id === expandedId ? " open" : ""}`;
        tr.title = "Klik untuk melihat detail timeout per baris";
        tr.addEventListener("click", () => {
          expandedId = expandedId === row.id ? null : row.id;
          loadLogs(true).catch((error) => Monitor.toast(error.message, "err"));
        });
        const startCell = cell(formatDateTime(row.started_at));
        const caret = document.createElement("span");
        caret.className = "log-caret";
        caret.textContent = "▸";
        startCell.prepend(caret);
        tr.appendChild(startCell);
        tr.appendChild(cell(row.device_label || `Perangkat #${row.device_id}`, `${row.device_type || ""} ${row.device_host || ""}`.trim()));
        tr.appendChild(cell(
          row.target ? (row.target_label ? `${row.target_label} → ${row.target}` : row.target) : (row.device_host || "—")
        ));
        tr.appendChild(cell(formatDateTime(row.recorded_at)));
        const statusCell = document.createElement("td");
        const badge = document.createElement("span");
        badge.className = `log-badge ${ongoing ? "ongoing" : "recovered"}`;
        badge.textContent = ongoing ? "BERLANGSUNG" : "PULIH";
        statusCell.appendChild(badge);
        if (!ongoing && row.recovered_at) {
          const small = document.createElement("span");
          small.className = "sub";
          small.textContent = formatDateTime(row.recovered_at);
          statusCell.appendChild(small);
        }
        tr.appendChild(statusCell);
        tr.appendChild(cell(
          ongoing
            ? formatDuration((Date.now() - new Date(row.started_at).getTime()) / 1000)
            : formatDuration(row.duration_seconds),
          ongoing ? "masih berjalan" : null
        ));
        tr.appendChild(cell(`${row.timeout_count}×`));
        body.appendChild(tr);

        if (row.id === expandedId) {
          const detailRow = document.createElement("tr");
          const detailCell = document.createElement("td");
          detailCell.colSpan = 7;
          detailCell.className = "log-detail-cell";
          detailCell.textContent = "Memuat detail...";
          detailRow.appendChild(detailCell);
          body.appendChild(detailRow);
          fillDetail(detailCell, row);
        }
      }
    }

    // Gambar isi detail dari data yang sudah ada (hasil API atau cache).
    function renderDetail(detailCell, logRow, data) {
      detailCell.replaceChildren();
      const head = document.createElement("div");
      head.className = "log-detail-head";
      const durationText = logRow.state === "ongoing"
        ? `durasi berjalan ${formatDuration((Date.now() - new Date(logRow.started_at).getTime()) / 1000)}`
        : `durasi total ${formatDuration(logRow.duration_seconds)}`;
      head.textContent = `Detail kejadian #${logRow.id}: ${data.total_entries} baris hasil timeout (${durationText})`
        + (data.truncated ? ` — hanya ${data.entries.length} baris pertama yang ditampilkan` : "");
      detailCell.appendChild(head);

      if (!data.entries.length) {
        const empty = document.createElement("div");
        empty.className = "log-empty";
        empty.textContent = "Tidak ada baris hasil ping pada jendela kejadian ini (riwayat ping_logs mungkin sudah terhapus oleh retensi).";
        detailCell.appendChild(empty);
        return;
      }
      const lines = document.createElement("div");
      lines.className = "log-lines";
      for (const entry of data.entries) {
        const line = document.createElement("div");
        line.className = "log-line";
        const time = document.createElement("span");
        time.className = "t";
        time.textContent = `[${clock(entry.created_at)}]`;
        line.append(time, document.createTextNode(entry.line));
        lines.appendChild(line);
      }
      detailCell.appendChild(lines);
    }

    // Isi baris detail sebuah kejadian: satu baris per hasil ping TIMEOUT
    // selama kejadian berlangsung (kejadian 10 detik ≈ 10 baris). Kejadian
    // yang sudah pulih dilayani dari cache setelah pemuatan pertama.
    async function fillDetail(detailCell, logRow) {
      const cached = logRow.state === "recovered" ? detailCache.get(logRow.id) : null;
      if (cached) {
        renderDetail(detailCell, logRow, cached);
        return;
      }
      try {
        const data = await Monitor.api(`/api/ping/timeout-logs/${logRow.id}/detail`);
        if (logRow.state === "recovered") detailCache.set(logRow.id, data);
        renderDetail(detailCell, logRow, data);
      } catch (error) {
        detailCell.textContent = `Detail gagal dimuat: ${error.message}`;
      }
    }

    function rowsSignature(rows) {
      return rows.map((row) => [row.id, row.state, row.timeout_count, row.recovered_at || "", row.duration_seconds ?? ""].join(":")).join("|");
    }

    async function loadLogs(force = false) {
      const rows = await Monitor.api("/api/ping/timeout-logs?limit=50");
      const list = Array.isArray(rows) ? rows : [];
      const signature = rowsSignature(list);
      // Penyegaran berkala tidak menggambar ulang — dan tidak memuat ulang
      // detail yang sedang dibaca — bila tidak ada kejadian yang berubah.
      if (!force && expandedId != null && signature === lastSignature) return;
      lastSignature = signature;
      renderRows(list);
    }

    async function loadSettings() {
      const settings = await Monitor.api("/api/ping/timeout-settings");
      if (settings && Number.isInteger(settings.threshold_seconds)) {
        thresholdInput.value = settings.threshold_seconds;
        settingsLoaded = true;
      }
    }

    async function loadAll() {
      try {
        if (!settingsLoaded) await loadSettings();
        await loadLogs(true);
      } catch (error) {
        Monitor.toast(error.message, "err");
      }
    }

    saveButton.addEventListener("click", async () => {
      const value = Number(thresholdInput.value);
      if (!Number.isInteger(value) || value < 1 || value > 3600) {
        Monitor.toast("Ambang harus bilangan bulat 1-3600 detik.", "err");
        return;
      }
      saveButton.disabled = true;
      try {
        const saved = await Monitor.api("/api/ping/timeout-settings", {
          method: "PUT",
          body: { threshold_seconds: value }
        });
        thresholdInput.value = saved.threshold_seconds;
        settingsLoaded = true;
        Monitor.toast(`Ambang log timeout disimpan: ${saved.threshold_seconds} detik.`);
      } catch (error) {
        Monitor.toast(error.message, "err");
      } finally {
        saveButton.disabled = false;
      }
    });
    refreshButton.addEventListener("click", loadAll);

    loadAll();
    // Masuk ke tampilan Log Timeout selalu menampilkan data terbaru.
    const logCard = document.getElementById("btn-logtimeout");
    if (logCard) logCard.addEventListener("click", () => loadLogs().catch(() => {}));
    // Segarkan daftar secara berkala selama tampilan Log Timeout terbuka.
    setInterval(() => {
      const logView = document.querySelector('[data-view="logtimeout"]');
      if (logView && !logView.hidden) loadLogs().catch(() => {});
    }, 15000);
  }

  initTimeoutLog();

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
