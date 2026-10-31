// Migrasi sekali jalan: longgarkan CHECK constraint slot_order (dulu 1-12, sekarang 1-240)
// supaya total device/sensor boleh lebih dari 12 ketika dibagi jadi beberapa slide.
// Jalankan manual: node scripts/migrate-slot-capacity.js
require("dotenv").config();
const mysql = require("mysql2/promise");

async function run() {
  const pool = await mysql.createConnection({
    host: process.env.MYSQL_HOST || "localhost",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE || "nadi_monitoring"
  });
  try {
    await pool.query("ALTER TABLE ping_devices DROP CONSTRAINT chk_ping_devices_slot");
    await pool.query("ALTER TABLE ping_devices ADD CONSTRAINT chk_ping_devices_slot CHECK (slot_order BETWEEN 1 AND 240)");
    await pool.query("ALTER TABLE prtg_sensors DROP CONSTRAINT chk_prtg_sensors_slot");
    await pool.query("ALTER TABLE prtg_sensors ADD CONSTRAINT chk_prtg_sensors_slot CHECK (slot_order BETWEEN 1 AND 240)");
    console.log("Constraint slot_order diperbarui jadi 1-240.");
  } finally {
    await pool.end();
  }
}

run().catch((error) => {
  console.error("Migrasi gagal:", error.code || error.message || error);
  process.exitCode = 1;
});
