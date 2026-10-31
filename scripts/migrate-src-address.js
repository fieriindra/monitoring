// Migrasi sekali jalan: tambah kolom src_address ke ping_devices (khusus MikroTik).
// Jalankan manual: node scripts/migrate-src-address.js
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
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ping_devices' AND COLUMN_NAME = 'src_address'"
    );
    if (columns.length) {
      console.log("Kolom src_address sudah ada, tidak ada perubahan.");
      return;
    }
    await pool.query("ALTER TABLE ping_devices ADD COLUMN src_address VARCHAR(100) NULL AFTER ping_command");
    console.log("Kolom src_address ditambahkan ke ping_devices.");
  } finally {
    await pool.end();
  }
}

run().catch((error) => {
  console.error("Migrasi gagal:", error.code || error.message || error);
  process.exitCode = 1;
});
