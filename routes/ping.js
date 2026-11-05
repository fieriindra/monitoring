const express = require("express");
const { encrypt } = require("../lib/crypto");
const { summarize } = require("../lib/parsers");
const v = require("../lib/validate");

const DEVICE_TYPES = ["HUAWEI", "JUNIPER", "MIKROTIK"];
const PUBLIC_COLUMNS = "id, label, host, port, username, device_type, ping_command, src_address, slot_order, is_active";

// Password SSH tidak pernah dikirim kembali ke client.
function createPingRouter({ pool, requireApiSession, worker }) {
  const router = express.Router();
  router.use(requireApiSession);

  // Rapikan urutan slot (position) di ping_targets menjadi 1..N tanpa celah.
  async function normalizeTargetPositions(connection) {
    const [rows] = await connection.query("SELECT id FROM ping_targets ORDER BY position, id");
    for (let i = 0; i < rows.length; i += 1) {
      await connection.execute("UPDATE ping_targets SET position = ? WHERE id = ?", [i + 1, rows[i].id]);
    }
  }

  // Lampirkan daftar target (urut posisi) dan item slot per-target ke tiap baris perangkat.
  async function attachTargets(rows) {
    if (!rows.length) return rows;
    let targetRows;
    try {
      [targetRows] = await pool.query(
        `SELECT id, device_id, target, label, logical_system, position FROM ping_targets WHERE device_id IN (?) ORDER BY position, id`,
        [rows.map((row) => row.id)]
      );
    } catch (error) {
      // Kolom logical_system belum ada (database lama, worker belum sempat
      // menjalankan migrasinya saat start): baca tanpa kolom itu.
      if (error.code !== "ER_BAD_FIELD_ERROR") throw error;
      [targetRows] = await pool.query(
        `SELECT id, device_id, target, label, position FROM ping_targets WHERE device_id IN (?) ORDER BY position, id`,
        [rows.map((row) => row.id)]
      );
    }
    const targetsByDevice = new Map();
    const targetItemsByDevice = new Map();
    for (const { id, device_id: deviceId, target, label, logical_system: logicalSystem, position } of targetRows) {
      if (!targetsByDevice.has(deviceId)) {
        targetsByDevice.set(deviceId, []);
        targetItemsByDevice.set(deviceId, []);
      }
      if (target) targetsByDevice.get(deviceId).push(target);
      targetItemsByDevice.get(deviceId).push({
        id,
        target: target || null,
        label: label || null,
        logical_system: logicalSystem || null,
        slot_order: position
      });
    }
    return rows.map((row) => ({
      ...row,
      targets: targetsByDevice.get(row.id) || [],
      target_items: targetItemsByDevice.get(row.id) || []
    }));
  }

  router.get("/devices", async (_request, response, next) => {
    try {
      const [rows] = await pool.execute(`SELECT ${PUBLIC_COLUMNS} FROM ping_devices ORDER BY slot_order, id`);
      response.json(await attachTargets(rows));
    } catch (error) {
      next(error);
    }
  });

  router.post("/devices", async (request, response, next) => {
    let connection;
    try {
      const body = request.body && typeof request.body === "object" ? request.body : {};
      const device = {
        label: v.text(body, "label", { label: "Label", max: 100 }),
        host: v.text(body, "host", {
          label: "Host", max: 100, pattern: /^[A-Za-z0-9.:-]+$/, patternMessage: "Host hanya boleh berisi huruf, angka, titik, titik dua, dan strip."
        }),
        port: v.integer(body, "port", { label: "Port", min: 1, max: 65535, fallback: 22 }),
        username: v.text(body, "username", { label: "Username", max: 100 }),
        password: v.text(body, "password", { label: "Password", max: 128, trim: false }),
        device_type: v.oneOf(body, "device_type", { label: "Tipe perangkat", values: DEVICE_TYPES }),
        ping_command: v.text(body, "ping_command", { label: "Ping command", max: 500 }),
        src_address: v.text(body, "src_address", {
          label: "Src-address", max: 100, optional: true,
          pattern: /^[A-Za-z0-9.:-]+$/, patternMessage: "Src-address hanya boleh berisi huruf, angka, titik, titik dua, dan strip."
        }),
        targets: v.targetList(body, "targets", { label: "Target" })
      };
      if (device.targets.length && !device.ping_command.includes("<IP>")) {
        throw new v.ValidationError("Ping command harus memuat placeholder <IP> ketika lebih dari satu target diisi.");
      }
      const slot = await v.nextFreeSlot(pool, "ping_devices");

      connection = await pool.getConnection();
      await connection.beginTransaction();
      const [result] = await connection.execute(
        `INSERT INTO ping_devices (label, host, port, username, password, device_type, ping_command, src_address, slot_order, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [device.label, device.host, device.port, device.username, encrypt(device.password), device.device_type, device.ping_command, device.src_address, slot]
      );
      const [[{ maxPos }]] = await connection.query("SELECT COALESCE(MAX(position), 0) AS maxPos FROM ping_targets");
      let nextPos = Number(maxPos) || 0;
      const targetEntries = device.targets.length ? device.targets : [{ target: "", label: null }];
      for (const entry of targetEntries) {
        nextPos += 1;
        await connection.execute(
          "INSERT INTO ping_targets (device_id, target, label, logical_system, position) VALUES (?, ?, ?, ?, ?)",
          [result.insertId, entry.target, entry.label, device.device_type === "JUNIPER" ? (entry.logical_system ?? null) : null, nextPos]
        );
      }
      await normalizeTargetPositions(connection);
      await connection.commit();
      worker.reload().catch((error) => console.error("Reload ping worker gagal:", error.code || error.message));

      const [rows] = await pool.execute(`SELECT ${PUBLIC_COLUMNS} FROM ping_devices WHERE id = ?`, [result.insertId]);
      response.status(201).json((await attachTargets(rows))[0]);
    } catch (error) {
      if (connection) await connection.rollback().catch(() => {});
      next(error);
    } finally {
      if (connection) connection.release();
    }
  });

  router.put("/devices/:id", async (request, response, next) => {
    let connection;
    try {
      const id = v.positiveId(request.params.id);
      const body = request.body && typeof request.body === "object" ? request.body : {};
      const device = {
        label: v.text(body, "label", { label: "Label", max: 100 }),
        host: v.text(body, "host", {
          label: "Host", max: 100, pattern: /^[A-Za-z0-9.:-]+$/, patternMessage: "Host hanya boleh berisi huruf, angka, titik, titik dua, dan strip."
        }),
        port: v.integer(body, "port", { label: "Port", min: 1, max: 65535, fallback: 22 }),
        username: v.text(body, "username", { label: "Username", max: 100 }),
        // Password kosong = tetap pakai password lama (tidak diubah).
        password: v.optionalSecret(body, "password", { label: "Password", max: 128 }),
        device_type: v.oneOf(body, "device_type", { label: "Tipe perangkat", values: DEVICE_TYPES }),
        ping_command: v.text(body, "ping_command", { label: "Ping command", max: 500 }),
        src_address: v.text(body, "src_address", {
          label: "Src-address", max: 100, optional: true,
          pattern: /^[A-Za-z0-9.:-]+$/, patternMessage: "Src-address hanya boleh berisi huruf, angka, titik, titik dua, dan strip."
        }),
        targets: v.targetList(body, "targets", { label: "Target" })
      };
      if (device.targets.length && !device.ping_command.includes("<IP>")) {
        throw new v.ValidationError("Ping command harus memuat placeholder <IP> ketika lebih dari satu target diisi.");
      }

      connection = await pool.getConnection();
      await connection.beginTransaction();
      const sql = device.password
        ? `UPDATE ping_devices SET label=?, host=?, port=?, username=?, password=?, device_type=?, ping_command=?, src_address=? WHERE id=?`
        : `UPDATE ping_devices SET label=?, host=?, port=?, username=?, device_type=?, ping_command=?, src_address=? WHERE id=?`;
      const params = device.password
        ? [device.label, device.host, device.port, device.username, encrypt(device.password), device.device_type, device.ping_command, device.src_address, id]
        : [device.label, device.host, device.port, device.username, device.device_type, device.ping_command, device.src_address, id];
      const [result] = await connection.execute(sql, params);
      if (!result.affectedRows) {
        await connection.rollback();
        return response.status(404).json({ error: "Perangkat tidak ditemukan." });
      }
      // Pertahankan posisi slot dan custom label target yang sudah ada agar urutan/nama di ATUR POSISI tidak hilang saat edit perangkat.
      let oldTargets;
      try {
        [oldTargets] = await connection.execute("SELECT target, label, logical_system, position FROM ping_targets WHERE device_id = ?", [id]);
      } catch (error) {
        if (error.code !== "ER_BAD_FIELD_ERROR") throw error;
        [oldTargets] = await connection.execute("SELECT target, label, position FROM ping_targets WHERE device_id = ?", [id]);
      }
      const oldMap = new Map(oldTargets.map((row) => [row.target, row]));
      const [[{ maxPos }]] = await connection.query("SELECT COALESCE(MAX(position), 0) AS maxPos FROM ping_targets");
      let nextPos = Number(maxPos) || 0;

      await connection.execute("DELETE FROM ping_targets WHERE device_id = ?", [id]);
      const targetEntries = device.targets.length ? device.targets : [{ target: "", label: null }];
      for (const entry of targetEntries) {
        const prev = oldMap.get(entry.target);
        const pos = prev ? prev.position : ++nextPos;
        const customLabel = entry.label !== null ? entry.label : (prev ? prev.label : null);
        // Logical-system hanya berlaku untuk Juniper. Field yang tidak dikirim
        // (undefined) mempertahankan nilai lama; null/string menggantikannya.
        const logicalSystem = device.device_type !== "JUNIPER"
          ? null
          : entry.logical_system !== undefined
            ? entry.logical_system
            : (prev ? prev.logical_system || null : null);
        await connection.execute(
          "INSERT INTO ping_targets (device_id, target, label, logical_system, position) VALUES (?, ?, ?, ?, ?)",
          [id, entry.target, customLabel, logicalSystem, pos]
        );
      }
      await normalizeTargetPositions(connection);
      await connection.commit();
      worker.reload().catch((error) => console.error("Reload ping worker gagal:", error.code || error.message));

      const [rows] = await pool.execute(`SELECT ${PUBLIC_COLUMNS} FROM ping_devices WHERE id = ?`, [id]);
      return response.json((await attachTargets(rows))[0]);
    } catch (error) {
      if (connection) await connection.rollback().catch(() => {});
      return next(error);
    } finally {
      if (connection) connection.release();
    }
  });

  router.delete("/devices/:id", async (request, response, next) => {
    let connection;
    try {
      const id = v.positiveId(request.params.id);
      connection = await pool.getConnection();
      await connection.beginTransaction();
      const [result] = await connection.execute("DELETE FROM ping_devices WHERE id = ?", [id]);
      if (!result.affectedRows) {
        await connection.rollback();
        return response.status(404).json({ error: "Perangkat tidak ditemukan." });
      }
      await normalizeTargetPositions(connection);
      await connection.commit();
      worker.reload().catch((error) => console.error("Reload ping worker gagal:", error.code || error.message));
      return response.json({ ok: true });
    } catch (error) {
      if (connection) await connection.rollback().catch(() => {});
      return next(error);
    } finally {
      if (connection) connection.release();
    }
  });

  // Hapus satu tujuan ping dari ATUR POSISI. Jika itu tujuan terakhir pada perangkat tersebut,
  // perangkat ikut dihapus agar tidak menyisakan perangkat kosong tanpa tujuan.
  router.delete("/targets/:id", async (request, response, next) => {
    let connection;
    try {
      const id = v.positiveId(request.params.id);
      connection = await pool.getConnection();
      await connection.beginTransaction();
      const [targetRows] = await connection.execute("SELECT id, device_id, target FROM ping_targets WHERE id = ? LIMIT 1", [id]);
      if (!targetRows.length) {
        await connection.rollback();
        return response.status(404).json({ error: "Tujuan ping tidak ditemukan." });
      }
      const { device_id: deviceId, target } = targetRows[0];
      const [[{ count }]] = await connection.execute("SELECT COUNT(*) AS count FROM ping_targets WHERE device_id = ?", [deviceId]);
      if (Number(count) <= 1) {
        await connection.execute("DELETE FROM ping_devices WHERE id = ?", [deviceId]);
      } else {
        await connection.execute("DELETE FROM ping_targets WHERE id = ?", [id]);
        if (target) {
          await connection.execute("DELETE FROM ping_logs WHERE device_id = ? AND target = ?", [deviceId, target]);
        }
      }
      await normalizeTargetPositions(connection);
      await connection.commit();
      worker.reload().catch((error) => console.error("Reload ping worker gagal:", error.code || error.message));
      return response.json({ ok: true });
    } catch (error) {
      if (connection) await connection.rollback().catch(() => {});
      return next(error);
    } finally {
      if (connection) connection.release();
    }
  });

  // ===== LOG TIMEOUT =====
  // Pengaturan ambang global: rangkaian RTO/timeout berurutan dicatat ke log
  // setelah berlangsung selama threshold_seconds (default 3, rentang 1-3600).

  router.get("/timeout-settings", async (_request, response, next) => {
    try {
      const [rows] = await pool.execute("SELECT threshold_seconds FROM ping_timeout_settings WHERE id = 1");
      return response.json({ threshold_seconds: rows.length ? Number(rows[0].threshold_seconds) : 3 });
    } catch (error) {
      // Tabel belum dibuat (worker belum sempat start): tampilkan nilai default.
      if (error.code === "ER_NO_SUCH_TABLE") return response.json({ threshold_seconds: 3 });
      return next(error);
    }
  });

  router.put("/timeout-settings", async (request, response, next) => {
    try {
      const threshold = v.integer(request.body, "threshold_seconds", { label: "Ambang timeout", min: 1, max: 3600 });
      if (typeof worker.ensureTimeoutLogSchema === "function") await worker.ensureTimeoutLogSchema();
      await pool.execute(
        `INSERT INTO ping_timeout_settings (id, threshold_seconds) VALUES (1, ?)
         ON DUPLICATE KEY UPDATE threshold_seconds = VALUES(threshold_seconds)`,
        [threshold]
      );
      // Terapkan langsung ke worker yang sedang berjalan (tanpa menunggu
      // penyegaran berkala dan tanpa restart).
      if (typeof worker.refreshTimeoutThreshold === "function") await worker.refreshTimeoutThreshold();
      return response.json({ threshold_seconds: threshold });
    } catch (error) {
      return next(error);
    }
  });

  // Log kejadian RTO/timeout berurutan, terbaru lebih dulu.
  router.get("/timeout-logs", async (request, response, next) => {
    try {
      const limit = Math.min(Math.max(parseInt(request.query.limit, 10) || 50, 1), 200);
      const [rows] = await pool.query(
        `SELECT l.id, l.device_id, l.target, l.started_at, l.recorded_at, l.recovered_at,
                l.duration_seconds, l.timeout_count,
                d.label AS device_label, d.host AS device_host, d.device_type AS device_type,
                t.label AS target_label
         FROM ping_timeout_logs l
         JOIN ping_devices d ON d.id = l.device_id
         LEFT JOIN ping_targets t ON t.device_id = l.device_id AND t.target = l.target
         ORDER BY l.id DESC LIMIT ?`,
        [limit]
      );
      return response.json(rows.map((row) => ({ ...row, state: row.recovered_at ? "recovered" : "ongoing" })));
    } catch (error) {
      if (error.code === "ER_NO_SUCH_TABLE") return response.json([]);
      return next(error);
    }
  });

  // Detail satu kejadian: baris-baris hasil ping TIMEOUT dari ping_logs selama
  // jendela kejadian (started_at s.d. recovered_at, atau sampai sekarang bila
  // masih berlangsung) — satu baris per hasil ping, jadi kejadian 10 detik
  // berisi sekitar 10 baris. Dibatasi DETAIL_MAX_ENTRIES baris; flag
  // "truncated" menandai bila yang ditampilkan hanya sebagian (yang terlama).
  const DETAIL_MAX_ENTRIES = 3600;
  router.get("/timeout-logs/:id/detail", async (request, response, next) => {
    try {
      const id = v.positiveId(request.params.id);
      const [logs] = await pool.execute(
        `SELECT l.id, l.device_id, l.target, l.started_at, l.recorded_at, l.recovered_at,
                l.duration_seconds, l.timeout_count,
                d.label AS device_label, d.host AS device_host, d.device_type AS device_type,
                t.label AS target_label
         FROM ping_timeout_logs l
         JOIN ping_devices d ON d.id = l.device_id
         LEFT JOIN ping_targets t ON t.device_id = l.device_id AND t.target = l.target
         WHERE l.id = ? LIMIT 1`,
        [id]
      );
      if (!logs.length) return response.status(404).json({ error: "Log timeout tidak ditemukan." });
      const log = logs[0];

      // Jalur cepat: snapshot detail yang disimpan worker ke
      // ping_timeout_log_details saat kejadian pulih — satu query terindeks
      // berdasarkan log_id, tanpa memindai ping_logs sama sekali. Kejadian
      // tanpa snapshot (masih berlangsung, tercatat sebelum fitur snapshot
      // ada, atau snapshot-nya gagal dibuat) memakai pemindaian jendela
      // ping_logs di bawah, persis seperti sebelumnya.
      try {
        const [snapRows] = await pool.query(
          "SELECT created_ts, status, latency, line FROM ping_timeout_log_details WHERE log_id = ? ORDER BY id ASC",
          [id]
        );
        if (snapRows.length) {
          const totalEntries = Math.max(snapRows.length, Number(log.timeout_count) || 0);
          return response.json({
            log: { ...log, state: log.recovered_at ? "recovered" : "ongoing" },
            total_entries: totalEntries,
            truncated: totalEntries > snapRows.length,
            entries: snapRows.map((row) => ({
              created_at: new Date(Number(row.created_ts) * 1000).toISOString(),
              status: row.status,
              latency: row.latency,
              line: row.line
            }))
          });
        }
      } catch (error) {
        if (error.code !== "ER_NO_SUCH_TABLE") throw error;
      }

      // Jendela dibandingkan sebagai epoch (UNIX_TIMESTAMP) agar tetap benar
      // walau zona waktu MySQL dan zona waktu proses Node berbeda: started_at
      // tersimpan sebagai DATETIME waktu lokal Node, sedangkan created_at
      // ping_logs adalah TIMESTAMP yang diisi MySQL — perbandingan string
      // tanggal mentah bisa meleset sebesar selisih zona waktu.
      const startEpoch = Math.floor(new Date(log.started_at).getTime() / 1000);
      const endEpoch = Math.floor((log.recovered_at ? new Date(log.recovered_at).getTime() : Date.now()) / 1000);
      const targetCondition = log.target === null ? "p.target IS NULL" : "p.target = ?";
      const windowParams = log.target === null ? [log.device_id] : [log.device_id, log.target];
      const windowPredicate = `p.device_id = ? AND ${targetCondition} AND p.status = 'TIMEOUT'
           AND UNIX_TIMESTAMP(p.created_at) >= ? AND UNIX_TIMESTAMP(p.created_at) <= ?`;
      const [[{ total }]] = await pool.query(
        `SELECT COUNT(*) AS total FROM ping_logs p WHERE ${windowPredicate}`,
        [...windowParams, startEpoch, endEpoch]
      );
      const [entryRows] = await pool.query(
        `SELECT UNIX_TIMESTAMP(p.created_at) AS created_ts, p.latency, p.status, p.raw_output
         FROM ping_logs p
         WHERE ${windowPredicate}
         ORDER BY p.created_at ASC, p.id ASC LIMIT ?`,
        [...windowParams, startEpoch, endEpoch, DETAIL_MAX_ENTRIES]
      );
      return response.json({
        log: { ...log, state: log.recovered_at ? "recovered" : "ongoing" },
        total_entries: Number(total),
        truncated: Number(total) > entryRows.length,
        entries: entryRows.map((row) => ({
          created_at: new Date(Number(row.created_ts) * 1000).toISOString(),
          status: row.status,
          latency: row.latency,
          line: summarize(row.raw_output, log.target || log.device_host)
        }))
      });
    } catch (error) {
      if (error.code === "ER_NO_SUCH_TABLE") return response.status(404).json({ error: "Log timeout tidak ditemukan." });
      return next(error);
    }
  });

  // Riwayat terbaru per perangkat+tujuan aktif, untuk mengisi terminal sebelum WebSocket mengalir.
  // Kunci hasil: "<device_id>" (tanpa target) atau "<device_id>:<target>".
  router.get("/recent", async (request, response, next) => {
    try {
      const limit = Math.min(Math.max(parseInt(request.query.limit, 10) || 20, 1), 100);
      const [devices] = await pool.execute("SELECT id FROM ping_devices WHERE is_active = 1");
      const result = {};
      for (const device of devices) {
        // Ambil lebih banyak baris lalu kelompokkan per target di JS, karena satu perangkat
        // bisa punya beberapa target yang saling berselang-seling di ping_logs.
        const [rows] = await pool.query(
          "SELECT target, latency, status, raw_output, created_at FROM ping_logs WHERE device_id = ? ORDER BY id DESC LIMIT ?",
          [device.id, limit * v.MAX_TARGETS_PER_DEVICE]
        );
        const byTarget = new Map();
        for (const row of rows) {
          const key = row.target ? `${device.id}:${row.target}` : `${device.id}`;
          if (!byTarget.has(key)) byTarget.set(key, []);
          const bucket = byTarget.get(key);
          if (bucket.length < limit) bucket.push(row);
        }
        for (const [key, bucket] of byTarget) {
          result[key] = bucket.reverse().map((row) => ({
            status: row.status,
            latency: row.latency,
            line: summarize(row.raw_output, row.target),
            created_at: row.created_at
          }));
        }
      }
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = createPingRouter;
