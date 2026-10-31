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
    const [targetRows] = await pool.query(
      `SELECT id, device_id, target, label, position FROM ping_targets WHERE device_id IN (?) ORDER BY position, id`,
      [rows.map((row) => row.id)]
    );
    const targetsByDevice = new Map();
    const targetItemsByDevice = new Map();
    for (const { id, device_id: deviceId, target, label, position } of targetRows) {
      if (!targetsByDevice.has(deviceId)) {
        targetsByDevice.set(deviceId, []);
        targetItemsByDevice.set(deviceId, []);
      }
      if (target) targetsByDevice.get(deviceId).push(target);
      targetItemsByDevice.get(deviceId).push({
        id,
        target: target || null,
        label: label || null,
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
          "INSERT INTO ping_targets (device_id, target, label, position) VALUES (?, ?, ?, ?)",
          [result.insertId, entry.target, entry.label, nextPos]
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
      const [oldTargets] = await connection.execute("SELECT target, label, position FROM ping_targets WHERE device_id = ?", [id]);
      const oldMap = new Map(oldTargets.map((row) => [row.target, row]));
      const [[{ maxPos }]] = await connection.query("SELECT COALESCE(MAX(position), 0) AS maxPos FROM ping_targets");
      let nextPos = Number(maxPos) || 0;

      await connection.execute("DELETE FROM ping_targets WHERE device_id = ?", [id]);
      const targetEntries = device.targets.length ? device.targets : [{ target: "", label: null }];
      for (const entry of targetEntries) {
        const prev = oldMap.get(entry.target);
        const pos = prev ? prev.position : ++nextPos;
        const customLabel = entry.label !== null ? entry.label : (prev ? prev.label : null);
        await connection.execute(
          "INSERT INTO ping_targets (device_id, target, label, position) VALUES (?, ?, ?, ?)",
          [id, entry.target, customLabel, pos]
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
