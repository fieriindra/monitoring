const express = require("express");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { encrypt, decrypt } = require("../lib/crypto");
const v = require("../lib/validate");

const TIME_RANGES = ["2h", "24h", "7d"];
const PUBLIC_COLUMNS = "id, label, prtg_ip, sensor_id, username, time_range, slot_order, is_active";
const UPSTREAM_TIMEOUT_MS = 15000;

// Rentang waktu grafik dan interval rata-rata (detik) yang dikirim ke PRTG.
const RANGE_SETTINGS = {
  "2h": { spanMs: 2 * 60 * 60 * 1000, avg: 0 },
  "24h": { spanMs: 24 * 60 * 60 * 1000, avg: 300 },
  "7d": { spanMs: 7 * 24 * 60 * 60 * 1000, avg: 3600 }
};

const pad = (n) => String(n).padStart(2, "0");
function prtgDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

class UpstreamError extends Error {
  constructor(message) {
    super(message);
    this.code = "APP_UPSTREAM";
  }
}

// Passhash hanya dipakai di sisi server; pesan error tidak pernah memuat URL/passhash.
function createPrtgRouter({ pool, requireApiSession }) {
  const router = express.Router();
  router.use(requireApiSession);

  async function loadSensor(idParam) {
    const id = v.positiveId(idParam);
    const [rows] = await pool.execute(
      "SELECT id, prtg_ip, sensor_id, username, passhash, time_range FROM prtg_sensors WHERE id = ? LIMIT 1",
      [id]
    );
    if (!rows[0]) return null;
    return { ...rows[0], passhash: decrypt(rows[0].passhash) };
  }

  async function fetchPrtg(url) {
    let upstream;
    try {
      upstream = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS), redirect: "error" });
    } catch {
      throw new UpstreamError("Server PRTG tidak dapat dihubungi.");
    }
    if (!upstream.ok) throw new UpstreamError(`Server PRTG membalas status ${upstream.status}. Periksa username/passhash dan ID sensor.`);
    return upstream;
  }

  router.get("/sensors", async (_request, response, next) => {
    try {
      const [rows] = await pool.execute(`SELECT ${PUBLIC_COLUMNS} FROM prtg_sensors ORDER BY slot_order, id`);
      response.json(rows);
    } catch (error) {
      next(error);
    }
  });

  router.post("/sensors", async (request, response, next) => {
    try {
      const body = request.body && typeof request.body === "object" ? request.body : {};
      const sensor = {
        label: v.text(body, "label", { label: "Label", max: 100 }),
        // Kosong = pakai kredensial server dari sensor PRTG lain yang sudah terdaftar (lihat di bawah).
        prtg_ip: v.text(body, "prtg_ip", {
          label: "IP/host PRTG", max: 100, pattern: /^[A-Za-z0-9.-]+(:\d{1,5})?$/,
          patternMessage: "IP/host PRTG hanya boleh berisi huruf, angka, titik, strip, dan port opsional (contoh 10.0.0.5:8080).",
          optional: true
        }),
        sensor_id: v.integer(body, "sensor_id", { label: "ID sensor", min: 1, max: 2147483647 }),
        username: v.text(body, "username", { label: "Username PRTG", max: 100, optional: true }),
        passhash: v.optionalSecret(body, "passhash", { label: "Passhash", max: 128 }),
        time_range: v.oneOf(body, "time_range", { label: "Rentang waktu", values: TIME_RANGES, fallback: "2h" })
      };

      // Passhash user diisi -> enkripsi dulu, sebelum kemungkinan ditimpa nilai existing (sudah terenkripsi).
      if (sensor.passhash !== null) sensor.passhash = encrypt(sensor.passhash);
      if (sensor.prtg_ip === null || sensor.username === null || sensor.passhash === null) {
        const [[existing]] = await pool.query(
          "SELECT prtg_ip, username, passhash FROM prtg_sensors ORDER BY id LIMIT 1"
        );
        if (!existing) {
          throw new v.ValidationError("IP/host, username, dan passhash wajib diisi untuk sensor pertama.");
        }
        if (sensor.prtg_ip === null) sensor.prtg_ip = existing.prtg_ip;
        if (sensor.username === null) sensor.username = existing.username;
        if (sensor.passhash === null) sensor.passhash = existing.passhash; // sudah terenkripsi, dipakai langsung
      }
      const slot = await v.nextFreeSlot(pool, "prtg_sensors");

      const [result] = await pool.execute(
        `INSERT INTO prtg_sensors (label, prtg_ip, sensor_id, username, passhash, time_range, slot_order, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        [sensor.label, sensor.prtg_ip, sensor.sensor_id, sensor.username, sensor.passhash, sensor.time_range, slot]
      );
      const [rows] = await pool.execute(`SELECT ${PUBLIC_COLUMNS} FROM prtg_sensors WHERE id = ?`, [result.insertId]);
      response.status(201).json(rows[0]);
    } catch (error) {
      next(error);
    }
  });

  router.put("/sensors/:id", async (request, response, next) => {
    try {
      const id = v.positiveId(request.params.id);
      const body = request.body && typeof request.body === "object" ? request.body : {};
      const sensor = {
        label: v.text(body, "label", { label: "Label", max: 100 }),
        prtg_ip: v.text(body, "prtg_ip", {
          label: "IP/host PRTG", max: 100, pattern: /^[A-Za-z0-9.-]+(:\d{1,5})?$/,
          patternMessage: "IP/host PRTG hanya boleh berisi huruf, angka, titik, strip, dan port opsional (contoh 10.0.0.5:8080)."
        }),
        sensor_id: v.integer(body, "sensor_id", { label: "ID sensor", min: 1, max: 2147483647 }),
        username: v.text(body, "username", { label: "Username PRTG", max: 100 }),
        // Passhash kosong = tetap pakai yang lama (tidak diubah).
        passhash: v.optionalSecret(body, "passhash", { label: "Passhash", max: 128 }),
        time_range: v.oneOf(body, "time_range", { label: "Rentang waktu", values: TIME_RANGES, fallback: "2h" })
      };

      const sql = sensor.passhash
        ? `UPDATE prtg_sensors SET label=?, prtg_ip=?, sensor_id=?, username=?, passhash=?, time_range=? WHERE id=?`
        : `UPDATE prtg_sensors SET label=?, prtg_ip=?, sensor_id=?, username=?, time_range=? WHERE id=?`;
      const params = sensor.passhash
        ? [sensor.label, sensor.prtg_ip, sensor.sensor_id, sensor.username, encrypt(sensor.passhash), sensor.time_range, id]
        : [sensor.label, sensor.prtg_ip, sensor.sensor_id, sensor.username, sensor.time_range, id];
      const [result] = await pool.execute(sql, params);
      if (!result.affectedRows) return response.status(404).json({ error: "Sensor tidak ditemukan." });

      const [rows] = await pool.execute(`SELECT ${PUBLIC_COLUMNS} FROM prtg_sensors WHERE id = ?`, [id]);
      return response.json(rows[0]);
    } catch (error) {
      return next(error);
    }
  });

  router.delete("/sensors/:id", async (request, response, next) => {
    try {
      const id = v.positiveId(request.params.id);
      const [result] = await pool.execute("DELETE FROM prtg_sensors WHERE id = ?", [id]);
      if (!result.affectedRows) return response.status(404).json({ error: "Sensor tidak ditemukan." });
      return response.json({ ok: true });
    } catch (error) {
      return next(error);
    }
  });

  // :id = id baris di tabel prtg_sensors (bukan ID sensor PRTG), agar kredensial diambil dari database.
  router.get("/chart/:id", async (request, response, next) => {
    try {
      const sensor = await loadSensor(request.params.id);
      if (!sensor) return response.status(404).json({ error: "Sensor tidak ditemukan." });

      const { spanMs, avg } = RANGE_SETTINGS[sensor.time_range];
      const now = new Date();
      const params = new URLSearchParams({
        type: "graph",
        id: String(sensor.sensor_id),
        width: "900",
        height: "420",
        avg: String(avg),
        sdate: prtgDate(new Date(now.getTime() - spanMs)),
        edate: prtgDate(now),
        username: sensor.username,
        passhash: sensor.passhash
      });
      const upstream = await fetchPrtg(`http://${sensor.prtg_ip}/chart.png?${params}`);

      const contentType = upstream.headers.get("content-type") || "";
      if (!contentType.startsWith("image/")) {
        throw new UpstreamError("PRTG tidak mengembalikan gambar grafik. Periksa username/passhash dan ID sensor.");
      }
      response.set({ "Content-Type": contentType, "Cache-Control": "no-store" });
      await pipeline(Readable.fromWeb(upstream.body), response);
    } catch (error) {
      if (response.headersSent) return response.destroy();
      return next(error);
    }
    return undefined;
  });

  router.get("/traffic/:id", async (request, response, next) => {
    try {
      const sensor = await loadSensor(request.params.id);
      if (!sensor) return response.status(404).json({ error: "Sensor tidak ditemukan." });

      const params = new URLSearchParams({
        content: "channels",
        output: "json",
        columns: "name,lastvalue_",
        id: String(sensor.sensor_id),
        username: sensor.username,
        passhash: sensor.passhash
      });
      const upstream = await fetchPrtg(`http://${sensor.prtg_ip}/api/table.json?${params}`);
      let data;
      try {
        data = await upstream.json();
      } catch {
        throw new UpstreamError("Balasan PRTG bukan JSON yang valid.");
      }

      const channels = Array.isArray(data.channels) ? data.channels : [];
      // Kolom "lastvalue_" di PRTG API menghasilkan pasangan field lastvalue (teks) +
      // lastvalue_raw (angka byte/detik) -> Mbps = byte * 8 / 1.000.000.
      const toMbps = (channel) => {
        if (!channel) return null;
        const raw = Number(String(channel.lastvalue_raw).replace(",", "."));
        return Number.isFinite(raw) ? Math.round((raw * 8 / 1e6) * 100) / 100 : null;
      };
      const find = (pattern) => channels.find((channel) => pattern.test(String(channel.name)));

      response.set("Cache-Control", "no-store");
      response.json({
        in_mbps: toMbps(find(/\b(traffic )?in\b/i)),
        out_mbps: toMbps(find(/\b(traffic )?out\b/i)),
        updated_at: new Date().toISOString()
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = createPrtgRouter;
