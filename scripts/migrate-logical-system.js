// Migrasi sekali jalan: tambah kolom logical_system ke ping_targets (khusus Juniper).
// Jalankan manual: node scripts/migrate-logical-system.js
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
    const [columns] = await pool.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ping_targets' AND COLUMN_NAME = 'logical_system'"
    );
    if (columns.length) {
      console.log("Kolom logical_system sudah ada, tidak ada perubahan.");
      return;
    }
    await pool.query("ALTER TABLE ping_targets ADD COLUMN logical_system VARCHAR(64) NULL AFTER label");
    console.log("Kolom logical_system ditambahkan ke ping_targets.");
  } finally {
    await pool.end();
  }
}

run().catch((error) => {
  console.error("Migrasi gagal:", error.code || error.message || error);
  process.exitCode = 1;
});
