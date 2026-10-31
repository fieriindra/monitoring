// Modul PRTG: form sensor + grafik live (refresh 30 detik) dengan teks Traffic In/Out.
(function () {
  "use strict";

  const REFRESH_MS = 30000;
  let timer = null;
  let active = false;

  function fmt(value) {
    if (value == null) return "—";
    if (value >= 1000) return `${(value / 1000).toFixed(2)} Gbps`;
    return `${value.toFixed(2)} Mbps`;
  }

  function buildCell(sensor) {
    const cell = document.createElement("div");
    cell.className = "cell";

    const head = document.createElement("div");
    head.className = "cell-head";
    const dot = document.createElement("span");
    dot.className = "dot";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = sensor.label;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = sensor.time_range;
    head.append(dot, title, meta);

    const wrap = document.createElement("div");
    wrap.className = "chart-wrap";
    const image = document.createElement("img");
    image.alt = `Grafik ${sensor.label}`;
    const message = document.createElement("div");
    message.className = "chart-msg";
    wrap.append(image, message);

    const traffic = document.createElement("div");
    traffic.className = "traffic";
    const inText = document.createElement("span");
    inText.className = "in";
    inText.textContent = "IN —";
    const outText = document.createElement("span");
    outText.className = "out";
    outText.textContent = "OUT —";
    traffic.append(inText, outText);

    cell.append(head, wrap, traffic);

    const refreshChart = () => {
      // Cache-buster timestamp; gambar baru dimuat di belakang layar agar tidak berkedip.
      const loader = new Image();
      loader.onload = () => {
        if (!active) return;
        image.src = loader.src;
        wrap.classList.remove("error");
        cell.classList.add("up");
        cell.classList.remove("timeout");
      };
      loader.onerror = () => {
        if (!active) return;
        message.textContent = "Grafik gagal dimuat. Periksa server PRTG, username/passhash, dan ID sensor.";
        wrap.classList.add("error");
        cell.classList.add("timeout");
        cell.classList.remove("up");
      };
      loader.src = `/api/prtg/chart/${sensor.id}?t=${Date.now()}`;
    };

    const refreshTraffic = async () => {
      try {
        const data = await Monitor.api(`/api/prtg/traffic/${sensor.id}`);
        if (!active) return;
        inText.textContent = `IN ${fmt(data.in_mbps)}`;
        outText.textContent = `OUT ${fmt(data.out_mbps)}`;
      } catch {
        if (!active) return;
        inText.textContent = "IN —";
        outText.textContent = "OUT —";
      }
    };

    return { cell, refresh: () => { refreshChart(); refreshTraffic(); } };
  }

  function startDisplay(grid, sensors, capacity) {
    active = true;
    grid.replaceChildren();
    const refreshers = [];
    for (let index = 0; index < capacity; index += 1) {
      const sensor = sensors[index];
      if (!sensor) {
        const empty = document.createElement("div");
        empty.className = "cell empty";
        empty.textContent = `SLOT ${index + 1} KOSONG`;
        grid.appendChild(empty);
        continue;
      }
      const built = buildCell(sensor);
      grid.appendChild(built.cell);
      refreshers.push(built.refresh);
    }
    const refreshAll = () => refreshers.forEach((refresh) => refresh());
    refreshAll();
    timer = setInterval(refreshAll, REFRESH_MS);
  }

  function stopDisplay() {
    active = false;
    clearInterval(timer);
    timer = null;
  }

  // Isi ulang form TAMBAH dengan data sensor yang mau diedit (dipanggil oleh monitor.js).
  function populateForm(form, item) {
    form.elements.label.value = item.label;
    form.elements.time_range.value = item.time_range;
    form.elements.prtg_ip.value = item.prtg_ip;
    form.elements.sensor_id.value = item.sensor_id;
    form.elements.username.value = item.username;
    form.elements.passhash.value = "";
  }

  function buildPayload(form) {
    const field = (name) => form.elements[name].value;
    // IP/username/passhash boleh dikosongkan: server otomatis memakai kredensial sensor
    // PRTG lain yang sudah ada (server sama). Saat edit, kosong = tidak diubah.
    return {
      label: field("label"),
      prtg_ip: field("prtg_ip"),
      sensor_id: field("sensor_id"),
      username: field("username"),
      passhash: field("passhash"),
      time_range: field("time_range")
    };
  }

  Monitor.register({
    endpoint: "/api/prtg/sensors",
    noun: "sensor",
    cardInfo: (item) => ({ title: item.label, sub: `${item.prtg_ip} · #${item.sensor_id} · ${item.time_range}` }),
    populateForm,
    buildPayload,
    startDisplay,
    stopDisplay
  });
})();
