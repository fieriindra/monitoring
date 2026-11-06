// Migrasi sekali jalan: buat tabel ping_device_jump_hosts (konfigurasi jump
// host khusus per perangkat, dikelola langsung di basis data).
// Jalankan manual: node scripts/migrate-jump-host.js
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
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ping_device_jump_hosts (
        device_id INT NOT NULL PRIMARY KEY,
        jump_host VARCHAR(255) NOT NULL,
        jump_port INT NOT NULL DEFAULT 22,
        jump_username VARCHAR(100) NOT NULL,
        jump_password VARCHAR(512) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_ping_device_jump_hosts_device FOREIGN KEY (device_id)
          REFERENCES ping_devices (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );
    console.log("Tabel ping_device_jump_hosts siap.");
  } finally {
    await pool.end();
  }
}

run().catch((error) => {
  console.error("Migrasi gagal:", error.code || error.message || error);
  process.exitCode = 1;
});
