-- Tabel modul Ping dan PRTG. Aman dijalankan berulang (IF NOT EXISTS).
-- Dijalankan otomatis oleh `npm run db:init`, atau manual:
--   mysql -u Monitoring -p nadi_monitoring < db/002_modules.sql
--
-- Kolom password / passhash menyimpan teks TERENKRIPSI (AES-256-GCM, base64),
-- bukan teks biasa. Lihat lib/crypto.js.

CREATE TABLE IF NOT EXISTS ping_devices (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  label VARCHAR(100) NOT NULL,
  host VARCHAR(100) NOT NULL,
  port INT NOT NULL DEFAULT 22,
  username VARCHAR(100) NOT NULL,
  password VARCHAR(255) NOT NULL,
  device_type ENUM('HUAWEI', 'JUNIPER', 'MIKROTIK') NOT NULL,
  ping_command TEXT NOT NULL,
  src_address VARCHAR(100) NULL, -- khusus MIKROTIK: diselipkan otomatis sebagai src-address= pada command ping.
  slot_order INT NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  KEY idx_ping_devices_active_slot (is_active, slot_order),
  CONSTRAINT chk_ping_devices_port CHECK (port BETWEEN 1 AND 65535),
  CONSTRAINT chk_ping_devices_slot CHECK (slot_order BETWEEN 1 AND 240)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS prtg_sensors (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  label VARCHAR(100) NOT NULL,
  prtg_ip VARCHAR(100) NOT NULL,
  sensor_id INT NOT NULL,
  username VARCHAR(100) NOT NULL,
  passhash VARCHAR(255) NOT NULL,
  time_range ENUM('2h', '24h', '7d') NOT NULL DEFAULT '2h',
  slot_order INT NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  KEY idx_prtg_sensors_active_slot (is_active, slot_order),
  CONSTRAINT chk_prtg_sensors_slot CHECK (slot_order BETWEEN 1 AND 240)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Pengaturan tampilan TAMPILKAN per modul: kapasitas slot per slide (2/4/6/8/10/12/14/16) dan
-- jeda rotasi otomatis antar slide (detik). Satu baris per modul, dibuat dengan nilai default.
CREATE TABLE IF NOT EXISTS display_settings (
  module VARCHAR(10) NOT NULL PRIMARY KEY,
  slot_capacity INT NOT NULL DEFAULT 12,
  rotate_seconds INT NOT NULL DEFAULT 30,
  manual_resume_seconds INT NOT NULL DEFAULT 60,
  CONSTRAINT chk_display_settings_capacity CHECK (slot_capacity IN (2, 4, 6, 8, 10, 12, 14, 16)),
  CONSTRAINT chk_display_settings_rotate CHECK (rotate_seconds BETWEEN 5 AND 600),
  CONSTRAINT chk_display_settings_resume CHECK (manual_resume_seconds BETWEEN 10 AND 3600)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO display_settings (module, slot_capacity, rotate_seconds) VALUES ('ping', 12, 30), ('prtg', 12, 30);

CREATE TABLE IF NOT EXISTS ping_targets (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  device_id INT NOT NULL,
  target VARCHAR(100) NOT NULL,
  label VARCHAR(100) NULL,
  logical_system VARCHAR(64) NULL,
  position INT NOT NULL DEFAULT 1,
  KEY idx_ping_targets_device (device_id, position),
  UNIQUE KEY uq_ping_targets_device_target (device_id, target),
  CONSTRAINT fk_ping_targets_device FOREIGN KEY (device_id)
    REFERENCES ping_devices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Konfigurasi jump host (SSH berantai) khusus per perangkat, dikelola
-- langsung di basis data (tidak ada antarmuka web/API). Worker menyambung
-- dulu ke jump host lalu membuka SSH bersarang ke perangkat. Baris ikut
-- terhapus otomatis saat perangkat dihapus (FK ON DELETE CASCADE).
CREATE TABLE IF NOT EXISTS ping_device_jump_hosts (
  device_id INT NOT NULL PRIMARY KEY,
  jump_host VARCHAR(255) NOT NULL,
  jump_port INT NOT NULL DEFAULT 22,
  jump_username VARCHAR(100) NOT NULL,
  jump_password VARCHAR(512) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ping_device_jump_hosts_device FOREIGN KEY (device_id)
    REFERENCES ping_devices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Satu perangkat boleh punya banyak tujuan ping. ping_devices.ping_command menjadi template
-- yang memuat <IP>. Perangkat lama tanpa baris di ping_targets tetap berjalan seperti semula.
CREATE TABLE IF NOT EXISTS ping_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  device_id INT NOT NULL,
  target VARCHAR(100) NULL,
  latency FLOAT NULL,
  status ENUM('UP', 'TIMEOUT') NOT NULL,
  raw_output TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ping_logs_device_created (device_id, created_at),
  KEY idx_ping_logs_created (created_at),
  CONSTRAINT fk_ping_logs_device FOREIGN KEY (device_id)
    REFERENCES ping_devices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- LOG TIMEOUT: satu baris per kejadian RTO/timeout BERURUTAN yang umurnya mencapai
-- ambang pada ping_timeout_settings. Baris dibuat saat ambang tercapai
-- (started_at = awal rangkaian, recorded_at = saat ambang tercapai), lalu dilengkapi
-- recovered_at + duration_seconds + timeout_count akhir saat tujuan kembali UP.
-- Tabel-tabel ini juga dibuat otomatis oleh worker saat start, jadi instalasi lama
-- tidak perlu menjalankan migrasi manual.
CREATE TABLE IF NOT EXISTS ping_timeout_settings (
  id TINYINT NOT NULL PRIMARY KEY, -- selalu 1 (satu baris pengaturan global)
  threshold_seconds INT NOT NULL DEFAULT 3,
  CONSTRAINT chk_ping_timeout_threshold CHECK (threshold_seconds BETWEEN 1 AND 3600)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO ping_timeout_settings (id, threshold_seconds) VALUES (1, 3);

CREATE TABLE IF NOT EXISTS ping_timeout_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  device_id INT NOT NULL,
  target VARCHAR(100) NULL,
  started_at DATETIME NOT NULL,
  recorded_at DATETIME NOT NULL,
  recovered_at DATETIME NULL,
  duration_seconds INT NULL,
  timeout_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ping_timeout_logs_created (created_at),
  KEY idx_ping_timeout_logs_device (device_id, created_at),
  CONSTRAINT fk_ping_timeout_logs_device FOREIGN KEY (device_id)
    REFERENCES ping_devices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Snapshot baris-baris detail per kejadian (satu baris per hasil ping TIMEOUT
-- selama kejadian, teks baris sudah diringkas siap tampil). Diisi worker saat
-- kejadian pulih — dan untuk kejadian lama lewat backfill saat start — supaya
-- endpoint detail membaca tabel kecil terindeks ini, bukan memindai ping_logs
-- pada jendela waktu setiap kali detail dibuka. Ikut terhapus otomatis lewat
-- FK CASCADE saat baris log induknya dihapus (retensi/perangkat). Tabel ini
-- juga dibuat otomatis oleh worker saat start.
CREATE TABLE IF NOT EXISTS ping_timeout_log_details (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  log_id BIGINT UNSIGNED NOT NULL,
  created_ts INT UNSIGNED NOT NULL, -- epoch detik waktu hasil ping
  status VARCHAR(10) NOT NULL DEFAULT 'TIMEOUT',
  latency FLOAT NULL,
  line VARCHAR(512) NOT NULL,
  KEY idx_ping_timeout_log_details_log (log_id, id),
  CONSTRAINT fk_ping_timeout_log_details_log FOREIGN KEY (log_id)
    REFERENCES ping_timeout_logs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
