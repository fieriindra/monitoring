require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const pool = require("../db");
const { decrypt } = require("../lib/crypto");

const backupDir = path.join(__dirname, "..", "backup");
const jsonPath = path.join(backupDir, "backup-monitoring.json");

function safeDecrypt(value) {
  try {
    return decrypt(value);
  } catch {
    return null;
  }
}

async function runBackup() {
  fs.mkdirSync(backupDir, { recursive: true });

  const [displaySettings] = await pool.query("SELECT module, slot_capacity, rotate_seconds FROM display_settings ORDER BY module");
  const [devices] = await pool.query(
    "SELECT id, label, host, port, username, password, device_type, ping_command, src_address, slot_order, is_active FROM ping_devices ORDER BY slot_order, id"
  );
  const [targets] = await pool.query(
    "SELECT id, device_id, target, label, logical_system, position FROM ping_targets ORDER BY position, id"
  );
  // Konfigurasi jump host khusus per perangkat (tabel opsional — instalasi
  // lama bisa belum punya).
  let jumpHosts = [];
  try {
    [jumpHosts] = await pool.query(
      "SELECT device_id, jump_host, jump_port, jump_username, jump_password FROM ping_device_jump_hosts"
    );
  } catch (error) {
    if (error.code !== "ER_NO_SUCH_TABLE") throw error;
  }
  const jumpByDevice = new Map(jumpHosts.map((j) => [j.device_id, {
    host: j.jump_host,
    port: j.jump_port,
    username: j.jump_username,
    password_plain: safeDecrypt(j.jump_password),
    password_encrypted: j.jump_password
  }]));
  const [sensors] = await pool.query(
    "SELECT id, label, prtg_ip, sensor_id, username, passhash, time_range, slot_order, is_active FROM prtg_sensors ORDER BY slot_order, id"
  );

  const targetsByDevice = new Map();
  for (const t of targets) {
    if (!targetsByDevice.has(t.device_id)) targetsByDevice.set(t.device_id, []);
    targetsByDevice.get(t.device_id).push({
      id: t.id,
      target: t.target,
      label: t.label || null,
      logical_system: t.logical_system || null,
      position: t.position
    });
  }

  const payload = {
    exported_at: new Date().toISOString(),
    display_settings: displaySettings,
    ping_devices: devices.map((d) => ({
      id: d.id,
      label: d.label,
      host: d.host,
      port: d.port,
      username: d.username,
      password_plain: safeDecrypt(d.password),
      password_encrypted: d.password,
      device_type: d.device_type,
      ping_command: d.ping_command,
      src_address: d.src_address,
      slot_order: d.slot_order,
      is_active: d.is_active,
      targets: targetsByDevice.get(d.id) || [],
      jump_host: jumpByDevice.get(d.id) || null
    })),
    prtg_sensors: sensors.map((s) => ({
      id: s.id,
      label: s.label,
      prtg_ip: s.prtg_ip,
      sensor_id: s.sensor_id,
      username: s.username,
      passhash_plain: safeDecrypt(s.passhash),
      passhash_encrypted: s.passhash,
      time_range: s.time_range,
      slot_order: s.slot_order,
      is_active: s.is_active
    }))
  };

  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), "utf8");
  console.log(`Backup JSON tersimpan di: ${jsonPath}`);
  console.log(`- Ping devices : ${payload.ping_devices.length} perangkat (${targets.length} tujuan ping)`);
  console.log(`- PRTG sensors : ${payload.prtg_sensors.length} sensor`);
}

runBackup()
  .catch((error) => {
    console.error("Gagal membuat backup:", error.message || error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
