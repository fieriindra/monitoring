require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const pool = require("../db");
const { encrypt } = require("../lib/crypto");

const jsonPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, "..", "backup", "backup-monitoring.json");

async function runRestore() {
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`File backup tidak ditemukan: ${jsonPath}`);
  }
  const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    if (Array.isArray(data.display_settings)) {
      for (const s of data.display_settings) {
        await connection.execute(
          `INSERT INTO display_settings (module, slot_capacity, rotate_seconds) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE slot_capacity = VALUES(slot_capacity), rotate_seconds = VALUES(rotate_seconds)`,
          [s.module, s.slot_capacity, s.rotate_seconds]
        );
      }
    }

    if (Array.isArray(data.ping_devices)) {
      await connection.execute("DELETE FROM ping_targets");
      await connection.execute("DELETE FROM ping_devices");
      for (const d of data.ping_devices) {
        const encPass = d.password_plain ? encrypt(d.password_plain) : d.password_encrypted;
        const [res] = await connection.execute(
          `INSERT INTO ping_devices (id, label, host, port, username, password, device_type, ping_command, src_address, slot_order, is_active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [d.id, d.label, d.host, d.port, d.username, encPass, d.device_type, d.ping_command, d.src_address || null, d.slot_order, d.is_active ?? 1]
        );
        const deviceId = d.id || res.insertId;
        for (const t of d.targets || []) {
          await connection.execute(
            "INSERT INTO ping_targets (device_id, target, label, position) VALUES (?, ?, ?, ?)",
            [deviceId, t.target || "", t.label || null, t.position || 1]
          );
        }
      }
    }

    if (Array.isArray(data.prtg_sensors)) {
      await connection.execute("DELETE FROM prtg_sensors");
      for (const s of data.prtg_sensors) {
        const encHash = s.passhash_plain ? encrypt(s.passhash_plain) : s.passhash_encrypted;
        await connection.execute(
          `INSERT INTO prtg_sensors (id, label, prtg_ip, sensor_id, username, passhash, time_range, slot_order, is_active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [s.id, s.label, s.prtg_ip, s.sensor_id, s.username, encHash, s.time_range || "2h", s.slot_order, s.is_active ?? 1]
        );
      }
    }

    await connection.commit();
    console.log(`Restore selesai dari: ${jsonPath}`);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

runRestore()
  .catch((error) => {
    console.error("Gagal melakukan restore:", error.message || error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
