require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const mysql = require("mysql2/promise");

const databaseName = process.env.MYSQL_DATABASE || "nadi_monitoring";

if (!/^[A-Za-z0-9_]+$/.test(databaseName)) {
  throw new Error("MYSQL_DATABASE hanya boleh berisi huruf, angka, dan garis bawah.");
}

async function initializeDatabase() {
  const connection = await mysql.createConnection({
    host: process.env.MYSQL_HOST || "localhost",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    multipleStatements: true
  });

  try {
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${databaseName}\``);
    await connection.query(`USE \`${databaseName}\``);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(64) NOT NULL UNIQUE,
        password_hash VARCHAR(60) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await connection.query(fs.readFileSync(path.join(__dirname, "..", "db", "002_modules.sql"), "utf8"));
    const [constraints] = await connection.query(
      "SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'display_settings' AND CONSTRAINT_NAME = 'chk_display_settings_capacity' AND CONSTRAINT_TYPE = 'CHECK'"
    );
    if (constraints.length) {
      await connection.query("ALTER TABLE display_settings DROP CONSTRAINT chk_display_settings_capacity");
    }
    await connection.query(
      "ALTER TABLE display_settings ADD CONSTRAINT chk_display_settings_capacity CHECK (slot_capacity IN (2, 4, 6, 8, 10, 12, 14, 16))"
    );
    const [labelCol] = await connection.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ping_targets' AND COLUMN_NAME = 'label'"
    );
    if (!labelCol.length) {
      await connection.query("ALTER TABLE ping_targets ADD COLUMN label VARCHAR(100) NULL AFTER target");
    }
    const [logicalSystemCol] = await connection.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ping_targets' AND COLUMN_NAME = 'logical_system'"
    );
    if (!logicalSystemCol.length) {
      await connection.query("ALTER TABLE ping_targets ADD COLUMN logical_system VARCHAR(64) NULL AFTER label");
    }
    const [resumeCol] = await connection.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'display_settings' AND COLUMN_NAME = 'manual_resume_seconds'"
    );
    if (!resumeCol.length) {
      await connection.query("ALTER TABLE display_settings ADD COLUMN manual_resume_seconds INT NOT NULL DEFAULT 60");
    }
  } finally {
    await connection.end();
  }

  console.log(`Database "${databaseName}" dan tabel monitoring siap; kapasitas slide hingga 16 slot diaktifkan.`);
}

initializeDatabase().catch((error) => {
  console.error("Gagal menyiapkan database:", error.code || error.message || error);
  process.exitCode = 1;
});
