const { EventEmitter } = require("node:events");
const { Client } = require("ssh2");
const { decrypt } = require("../lib/crypto");
const { parsePing, summarize } = require("../lib/parsers");
const { TimeoutTracker } = require("../lib/timeoutTracker");
const { buildPingCommand } = require("../lib/pingCommand");

const INTERVAL_MS = 1000;
const CONNECT_TIMEOUT_MS = 8000;
// Batas waktu perintah ping untuk SEMUA vendor (exec Juniper/MikroTik dan shell
// Huawei): ping multi-paket ke target RTO butuh (jumlah paket x jendela tunggu)
// untuk selesai secara sah — Huawei 5 paket x 2000 ms timeout default VRP,
// Juniper 3 paket interval 1 detik + wait, MikroTik 3 x interval 1 detik
// (di RouterOS interval sekaligus menjadi jendela timeout per paket).
// Batas lama 6 detik memotong RTO yang sah dan membuangnya sebagai error SSH.
const COMMAND_TIMEOUT_MS = 20000;
const MAX_OUTPUT_CHARS = 4000;
const CLEANUP_BATCH = 10000;
// LOG TIMEOUT: ambang default rangkaian RTO berurutan sebelum dicatat (detik).
// Nilai aktif dibaca dari tabel ping_timeout_settings dan disegarkan berkala,
// jadi perubahan dari halaman Ping Monitoring berlaku tanpa restart.
const DEFAULT_TIMEOUT_THRESHOLD_SECONDS = 3;
const TIMEOUT_SETTINGS_REFRESH_MS = 10000;
// Snapshot detail kejadian: maksimal baris TIMEOUT yang disimpan per kejadian
// (sama dengan batas tampil endpoint detail di routes/ping.js).
const TIMEOUT_DETAIL_MAX_ENTRIES = 3600;
const HUAWEI_PROMPT_RE = /(?:<[^>\r\n]+>|\[[^\]\r\n]+\])\s*$/;
const HUAWEI_PROMPT_ANYWHERE_RE = /(?:<[^>\r\n]+>|\[[^\]\r\n]+\])/;

// Output ping sudah bisa diputuskan hasilnya (bukan kegagalan SSH) bila memuat
// statistik akhir, baris "Request time out", atau setidaknya satu balasan.
// Dipakai saat batas waktu shell tercapai: hasil seperti ini dikembalikan apa
// adanya untuk diparse, bukan dibuang/diulang sebagai error SSH — pengulangan
// dan penandaan "gagal" akan menyebarkan TIMEOUT palsu ke target lain.
function hasConclusivePingOutput(output) {
  return /packet loss/i.test(output)
    || /request time out/i.test(output)
    || /reply from\s+\S+.*\btime\s*[=<]/i.test(output)
    || /\d+\s+packets?(?:\(s\))?\s+received/i.test(output)
    || /\bsent=\d+\s+received=\d+/i.test(output)
    || /packet-loss=\d/i.test(output);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function connect(device) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    // Pakai .on (bukan .once) dan tetap terpasang selamanya: ssh2 bisa emit 'error' lebih
    // dari sekali sebelum/selama koneksi (mis. reset lalu timeout). Tanpa listener permanen,
    // error susulan jadi unhandled 'error' event dan mematikan seluruh proses Node.
    client.on("error", (error) => {
      if (settled) return; // sudah ready/reject sebelumnya: serap saja, jangan crash proses
      settled = true;
      reject(error);
    });
    client.once("ready", () => {
      settled = true;
      resolve(client);
    });
    client.connect({
      host: device.host,
      port: device.port,
      username: device.username,
      password: device.password,
      readyTimeout: CONNECT_TIMEOUT_MS,
      keepaliveInterval: 10000,
      // Perangkat lama (Huawei/Juniper/MikroTik versi lawas) kadang hanya mendukung kex ini.
      algorithms: { kex: { append: ["diffie-hellman-group1-sha1"] } }
    });
  });
}

function runCommand(client, command) {
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const finish = (err, res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(res);
    };
    const timer = setTimeout(() => {
      // Sama seperti shell Huawei: bila output yang terkumpul sudah konklusif
      // (statistik akhir / ada balasan / bukti RTO), itu hasil ping yang sah —
      // kembalikan untuk diparse, jangan dibuang sebagai error SSH.
      if (hasConclusivePingOutput(output)) return finish(null, output);
      return finish(new Error("perintah melebihi batas waktu"));
    }, COMMAND_TIMEOUT_MS);
    client.exec(command, (error, stream) => {
      if (error) return finish(error);
      const collect = (chunk) => {
        if (output.length < MAX_OUTPUT_CHARS) output += chunk.toString("utf8");
      };
      stream.on("data", collect);
      stream.stderr.on("data", collect);
      stream.on("close", () => finish(null, output));
      return undefined;
    });
  });
}

// Huawei VRP menutup koneksi SSH bila memakai client.exec() berulang, sehingga memicu login ulang
// terus-menerus dan kadang terpotong di banner (false TIMEOUT). Solusi: buka 1 shell interaktif
// persisten dan jalankan perintah ping di dalam shell tersebut.
function openInteractiveShell(client) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("shell prompt melebihi batas waktu")), CONNECT_TIMEOUT_MS);
    client.shell({ term: "dumb", cols: 200, rows: 40 }, (error, stream) => {
      if (error) {
        clearTimeout(timer);
        return reject(error);
      }
      let bannerBuf = "";
      const onData = (chunk) => {
        bannerBuf += chunk.toString("utf8");
        if (bannerBuf.length > MAX_OUTPUT_CHARS) bannerBuf = bannerBuf.slice(-MAX_OUTPUT_CHARS);
        if (HUAWEI_PROMPT_RE.test(bannerBuf)) {
          clearTimeout(timer);
          stream.removeListener("data", onData);
          resolve(stream);
        }
      };
      stream.on("data", onData);
      stream.once("close", () => {
        clearTimeout(timer);
        stream.removeListener("data", onData);
        reject(new Error("shell tertutup sebelum prompt siap"));
      });
    });
  });
}

function runShellCommand(stream, command) {
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const finish = (err, res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("close", onClose);
      if (err) reject(err);
      else resolve(res);
    };
    const timer = setTimeout(() => {
      // Batas waktu tercapai: bila output yang terkumpul sudah konklusif (target
      // memang RTO atau ada balasan), itu hasil ping yang sah — kembalikan untuk
      // diparse. Hanya output yang tidak bisa diputuskan yang dianggap gagal.
      if (hasConclusivePingOutput(output)) return finish(null, output);
      return finish(new Error("perintah shell melebihi batas waktu"));
    }, COMMAND_TIMEOUT_MS);
    const onData = (chunk) => {
      if (output.length < MAX_OUTPUT_CHARS) output += chunk.toString("utf8");
      // Selesai ketika statistik ping sudah keluar dan prompt CLI (<...>) muncul
      // kembali SETELAH statistik itu. Prompt tidak harus berada tepat di ujung
      // buffer: potongan data SSH bisa menyertakan baris kosong/banner setelahnya,
      // dan menunggu prompt persis di ujung membuat perintah yang sebenarnya
      // sudah selesai menggantung sampai batas waktu.
      const statsIndex = output.search(/packet loss/i);
      if (statsIndex >= 0 && HUAWEI_PROMPT_ANYWHERE_RE.test(output.slice(statsIndex))) {
        finish(null, output);
        return;
      }
      if ((/Error:|Unrecognized|Wrong parameter/i.test(output)) && HUAWEI_PROMPT_RE.test(output)) {
        finish(null, output);
      }
    };
    const onClose = () => finish(new Error("shell tertutup saat menjalankan perintah"));
    stream.on("data", onData);
    stream.once("close", onClose);
    stream.write(`${command}\r\n`);
  });
}

// Tanda tangan konfigurasi yang memengaruhi cara loop ping jalan; dipakai reload() untuk
// mendeteksi device yang diedit (host/password/command/target berubah) agar loop di-restart.
function signature(row, targets) {
  return JSON.stringify([row.host, row.port, row.username, row.password, row.ping_command, row.src_address, targets]);
}

class DeviceLoop {
  constructor(device, owner) {
    this.device = device;
    this.owner = owner;
    this.client = null;
    this.shellStream = null;
    this.stopped = false;
    this.wakeTimer = null;
    this.wake = null;
  }

  commandFor(entry) {
    // Template memakai <IP>; tanpa target (perangkat lama) diganti host perangkat.
    // Juniper: logical-system tujuan diselipkan sebelum IP; MikroTik:
    // src-address= diselipkan setelah /ping. Lihat lib/pingCommand.js.
    return buildPingCommand(this.device, entry);
  }

  drop() {
    if (this.shellStream) {
      try { this.shellStream.close(); } catch { /* sudah tertutup */ }
      this.shellStream = null;
    }
    if (this.client) {
      try { this.client.end(); } catch { /* sudah tertutup */ }
      this.client = null;
    }
  }

  async pause(ms) {
    if (ms <= 0 || this.stopped) return;
    await new Promise((resolve) => {
      this.wake = resolve;
      this.wakeTimer = setTimeout(resolve, ms);
    });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.wakeTimer);
    if (this.wake) this.wake();
    this.drop();
  }

  async probeOnce(command) {
    if (!this.client) {
      this.client = await connect(this.device);
      const client = this.client;
      client.once("close", () => {
        if (this.client === client) {
          this.client = null;
          this.shellStream = null;
        }
      });
    }
    if (this.device.device_type === "HUAWEI") {
      if (!this.shellStream) {
        this.shellStream = await openInteractiveShell(this.client);
        const stream = this.shellStream;
        stream.once("close", () => {
          if (this.shellStream === stream) this.shellStream = null;
        });
      }
      return runShellCommand(this.shellStream, command);
    }
    return runCommand(this.client, command);
  }

  // Mengembalikan { output, failed }. Bila gagal karena sesi SSH putus di tengah jalan,
  // coba sekali lagi dengan koneksi baru agar tidak menghasilkan false TIMEOUT.
  async probe(command) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return { output: await this.probeOnce(command), failed: false };
      } catch (error) {
        this.drop();
        if (attempt === 2 || this.stopped) {
          return { output: `SSH error: ${error.message}`, failed: true };
        }
      }
    }
    return { output: "SSH error", failed: true };
  }

  // Satu siklus = semua tujuan dijalankan berurutan lewat satu koneksi (aman untuk perangkat
  // dengan batas sesi kecil). Bila SSH gagal, tujuan sisa tidak dicoba lagi pada siklus itu.
  async run() {
    while (!this.stopped) {
      const startedAt = Date.now();
      const targets = this.device.targets.length ? this.device.targets : [null];
      let failure = null;
      for (const entry of targets) {
        if (this.stopped) break;
        let result = failure;
        if (!result) {
          result = await this.probe(this.commandFor(entry));
          if (result.failed) failure = result;
        }
        if (this.stopped) break;
        const output = result.output.slice(0, MAX_OUTPUT_CHARS);
        const { status, latency } = parsePing(output);
        const target = entry && entry.ip ? entry.ip : null;
        await this.owner.record(this.device, { target, status, latency, output });
      }
      await this.pause(INTERVAL_MS - (Date.now() - startedAt));
    }
  }
}

class PingWorker extends EventEmitter {
  constructor(pool) {
    super();
    this.pool = pool;
    this.loops = new Map();
    this.cleanupTimer = null;
    this.halted = false;
    this.timeoutTracker = new TimeoutTracker();
    this.timeoutLogIds = new Map();
    this.timeoutThresholdSeconds = DEFAULT_TIMEOUT_THRESHOLD_SECONDS;
    this.timeoutSettingsTimer = null;
  }

  // Dipanggil saat aplikasi start. Mencoba ulang sampai MySQL siap.
  async start() {
    this.halted = false;
    while (!this.halted) {
      try {
        await this.ensureTimeoutLogSchema();
        await this.ensureTargetLogicalSystemSchema();
        await this.refreshTimeoutThreshold();
        await this.reload();
        break;
      } catch (error) {
        console.error("Ping worker belum bisa mulai:", error.code || error.message);
        await sleep(10000);
      }
    }
    if (this.halted || this.cleanupTimer) return;
    const retentionDays = Math.max(1, Number(process.env.PING_LOG_RETENTION_DAYS || 7));
    // Backfill snapshot detail kejadian lama di latar belakang; kegagalan
    // atau ketiadaannya tidak menghalangi start (endpoint memakai jalur
    // pemindaian lama untuk kejadian tanpa snapshot).
    this.backfillTimeoutDetailSnapshots(retentionDays).catch((error) =>
      console.error("Backfill snapshot detail gagal:", error.code || error.message));
    // Bersihkan sekali saat start agar log kedaluwarsa langsung hilang setelah
    // deploy/restart, lalu ulangi setiap jam.
    this.cleanup(retentionDays).catch((error) => console.error("Pembersihan log gagal:", error.code || error.message));
    this.cleanupTimer = setInterval(() => {
      this.cleanup(retentionDays).catch((error) => console.error("Pembersihan log gagal:", error.code || error.message));
    }, 60 * 60 * 1000);
    this.cleanupTimer.unref();
    this.timeoutSettingsTimer = setInterval(() => {
      this.refreshTimeoutThreshold().catch(() => {});
    }, TIMEOUT_SETTINGS_REFRESH_MS);
    this.timeoutSettingsTimer.unref();
  }

  stop() {
    this.halted = true;
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    clearInterval(this.timeoutSettingsTimer);
    this.timeoutSettingsTimer = null;
    for (const loop of this.loops.values()) loop.stop();
    this.loops.clear();
  }

  // Tabel LOG TIMEOUT dibuat otomatis (identik dengan db/002_modules.sql) agar
  // instalasi lama yang hanya deploy + restart langsung mendapat fitur ini.
  async ensureTimeoutLogSchema() {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ping_timeout_settings (
        id TINYINT NOT NULL PRIMARY KEY,
        threshold_seconds INT NOT NULL DEFAULT 3,
        CONSTRAINT chk_ping_timeout_threshold CHECK (threshold_seconds BETWEEN 1 AND 3600)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );
    await this.pool.query("INSERT IGNORE INTO ping_timeout_settings (id, threshold_seconds) VALUES (1, 3)");
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ping_timeout_logs (
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );
    // Snapshot baris-baris detail per kejadian, diisi worker saat kejadian
    // pulih. Endpoint detail membaca tabel kecil terindeks ini — bukan lagi
    // memindai ping_logs pada jendela waktu setiap detail dibuka. Baris
    // snapshot ikut terhapus otomatis (FK CASCADE) saat baris log induknya
    // dihapus retensi/perangkat.
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ping_timeout_log_details (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        log_id BIGINT UNSIGNED NOT NULL,
        created_ts INT UNSIGNED NOT NULL,
        status VARCHAR(10) NOT NULL DEFAULT 'TIMEOUT',
        latency FLOAT NULL,
        line VARCHAR(512) NOT NULL,
        KEY idx_ping_timeout_log_details_log (log_id, id),
        CONSTRAINT fk_ping_timeout_log_details_log FOREIGN KEY (log_id)
          REFERENCES ping_timeout_logs (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );
  }

  // Kolom logical_system pada ping_targets (khusus Juniper: tiap tujuan bisa
  // diarahkan ke logical-system-nya sendiri) ditambahkan otomatis agar
  // instalasi lama yang hanya deploy + restart langsung mendapat fitur ini,
  // sama seperti tabel LOG TIMEOUT di atas.
  async ensureTargetLogicalSystemSchema() {
    const [columns] = await this.pool.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ping_targets' AND COLUMN_NAME = 'logical_system'"
    );
    if (!columns.length) {
      await this.pool.query("ALTER TABLE ping_targets ADD COLUMN logical_system VARCHAR(64) NULL AFTER label");
    }
  }

  // Ambang aktif dari pengaturan global; gagal baca (MySQL belum siap) memakai
  // nilai terakhir yang diketahui, dan awalnya default 3 detik.
  async refreshTimeoutThreshold() {
    try {
      const [rows] = await this.pool.execute("SELECT threshold_seconds FROM ping_timeout_settings WHERE id = 1");
      const value = rows.length ? Number(rows[0].threshold_seconds) : NaN;
      if (Number.isInteger(value) && value >= 1 && value <= 3600) {
        this.timeoutThresholdSeconds = value;
      }
    } catch {
      // Abaikan: nilai terakhir tetap dipakai.
    }
  }

  // Sinkronkan loop dengan isi ping_devices aktif (urut slot_order). Dipanggil setelah tambah/hapus.
  async reload() {
    const [rows] = await this.pool.execute(
      "SELECT id, label, host, port, username, password, device_type, ping_command, src_address FROM ping_devices WHERE is_active = 1 ORDER BY slot_order, id"
    );
    let targetRows;
    try {
      [targetRows] = await this.pool.execute("SELECT device_id, target, logical_system FROM ping_targets ORDER BY device_id, position, id");
    } catch (error) {
      // Kolom logical_system belum ada (migrasi di start belum berjalan).
      if (error.code !== "ER_BAD_FIELD_ERROR") throw error;
      [targetRows] = await this.pool.execute("SELECT device_id, target FROM ping_targets ORDER BY device_id, position, id");
    }
    const targetsByDevice = new Map();
    for (const { device_id: deviceId, target, logical_system: logicalSystem } of targetRows) {
      if (!targetsByDevice.has(deviceId)) targetsByDevice.set(deviceId, []);
      targetsByDevice.get(deviceId).push({ ip: target || "", logicalSystem: logicalSystem || null });
    }
    const wanted = new Map(rows.map((row) => [row.id, row]));

    for (const [id, loop] of this.loops) {
      if (!wanted.has(id)) {
        loop.stop();
        this.loops.delete(id);
      }
    }

    // Perangkat yang sudah tidak aktif/dihapus tidak perlu dilacak rangkaian timeout-nya.
    for (const key of [...this.timeoutTracker.streaks.keys()]) {
      if (!wanted.has(Number(key.split("|")[0]))) {
        this.timeoutTracker.forget(key);
        this.timeoutLogIds.delete(key);
      }
    }

    for (const row of rows) {
      const targets = targetsByDevice.get(row.id) || [];
      let password;
      try {
        password = decrypt(row.password);
      } catch (error) {
        if (error.code === "APP_ENCRYPTION_NOT_CONFIGURED") throw error;
        console.error(`Password perangkat #${row.id} tidak bisa didekripsi; perangkat dilewati.`);
        continue;
      }
      const sig = signature(row, targets);
      const existing = this.loops.get(row.id);
      // Perangkat sudah di-edit (host/password/command/target berubah): hentikan loop lama, mulai ulang.
      if (existing) {
        if (existing.sig === sig) continue;
        existing.stop();
        this.loops.delete(row.id);
      }
      const loop = new DeviceLoop({ ...row, password, targets }, this);
      loop.sig = sig;
      this.loops.set(row.id, loop);
      loop.run().catch((error) => console.error(`Loop perangkat #${row.id} berhenti:`, error.message));
    }
  }

  async record(device, { target, status, latency, output }) {
    const createdAt = new Date();
    try {
      await this.pool.execute(
        "INSERT INTO ping_logs (device_id, target, latency, status, raw_output) VALUES (?, ?, ?, ?, ?)",
        [device.id, target || null, latency, status, output]
      );
    } catch (error) {
      // Perangkat dihapus saat loop berjalan (FK) atau MySQL sementara tidak tersedia.
      if (error.code !== "ER_NO_REFERENCED_ROW_2") console.error("Gagal menyimpan ping_logs:", error.code || error.message);
    }
    this.emit("result", {
      device_id: device.id,
      target: target || null,
      status,
      latency,
      line: summarize(output, target || device.host),
      raw: output,
      created_at: createdAt.toISOString()
    });
    try {
      await this.trackTimeout(device, target || null, status, createdAt);
    } catch (error) {
      console.error("Pelacakan log timeout gagal:", error.code || error.message);
    }
  }

  // LOG TIMEOUT: masukkan hasil ke pelacak rangkaian; event "record" menjadi
  // baris baru ping_timeout_logs, event "recover" melengkapi baris yang sama.
  async trackTimeout(device, target, status, createdAt) {
    const key = `${device.id}|${target || ""}`;
    const event = this.timeoutTracker.feed(key, status, createdAt.getTime(), this.timeoutThresholdSeconds);
    if (!event) return;

    if (event.type === "record") {
      try {
        const [result] = await this.pool.execute(
          "INSERT INTO ping_timeout_logs (device_id, target, started_at, recorded_at, timeout_count) VALUES (?, ?, ?, ?, ?)",
          [device.id, target, new Date(event.startedAt), new Date(event.recordedAt), event.timeoutCount]
        );
        this.timeoutLogIds.set(key, result.insertId);
      } catch (error) {
        // Perangkat dihapus saat loop berjalan (FK) atau MySQL sementara tidak tersedia:
        // izinkan event terbit lagi pada hasil TIMEOUT berikutnya.
        if (error.code !== "ER_NO_REFERENCED_ROW_2") console.error("Gagal menyimpan log timeout:", error.code || error.message);
        this.timeoutTracker.markUnrecorded(key);
      }
      return;
    }

    const logId = this.timeoutLogIds.get(key);
    this.timeoutLogIds.delete(key);
    if (!logId) return;
    try {
      await this.pool.execute(
        "UPDATE ping_timeout_logs SET recovered_at = ?, duration_seconds = ?, timeout_count = ? WHERE id = ?",
        [new Date(event.endedAt), event.durationSeconds, event.timeoutCount, logId]
      );
    } catch (error) {
      console.error("Gagal melengkapi log timeout:", error.code || error.message);
      return;
    }
    // Simpan snapshot baris detail selagi baris-barisnya masih ada di
    // ping_logs, agar detail kejadian ini selanjutnya dibaca dari tabel
    // snapshot yang kecil. Kegagalan di sini tidak membatalkan pemulihan
    // yang sudah tercatat — endpoint detail akan memakai jalur pemindaian
    // ping_logs seperti sebelumnya.
    try {
      await this.snapshotTimeoutDetail(logId, {
        deviceId: device.id,
        target,
        host: device.host,
        startedAt: event.startedAt,
        endedAt: event.endedAt
      });
    } catch (error) {
      console.error("Gagal menyimpan snapshot detail timeout:", error.code || error.message);
    }
  }

  // Salin baris-baris hasil ping TIMEOUT selama jendela kejadian dari
  // ping_logs ke ping_timeout_log_details, dengan teks baris yang sudah
  // diringkas (summarize) siap tampil. Idempoten: snapshot lama untuk
  // kejadian yang sama diganti. Jendela dibandingkan sebagai epoch —
  // alasan yang sama seperti endpoint detail (zona waktu MySQL vs Node).
  async snapshotTimeoutDetail(logId, { deviceId, target, host, startedAt, endedAt }) {
    const startEpoch = Math.floor(startedAt / 1000);
    const endEpoch = Math.floor(endedAt / 1000);
    const targetCondition = target === null ? "target IS NULL" : "target = ?";
    const windowParams = target === null ? [deviceId] : [deviceId, target];
    const [rows] = await this.pool.query(
      `SELECT UNIX_TIMESTAMP(created_at) AS created_ts, status, latency, raw_output
       FROM ping_logs
       WHERE device_id = ? AND ${targetCondition} AND status = 'TIMEOUT'
         AND UNIX_TIMESTAMP(created_at) >= ? AND UNIX_TIMESTAMP(created_at) <= ?
       ORDER BY created_at ASC, id ASC LIMIT ?`,
      [...windowParams, startEpoch, endEpoch, TIMEOUT_DETAIL_MAX_ENTRIES]
    );
    await this.pool.execute("DELETE FROM ping_timeout_log_details WHERE log_id = ?", [logId]);
    if (!rows.length) return 0;
    const values = rows.map((row) => [
      logId,
      Number(row.created_ts),
      row.status,
      row.latency,
      summarize(row.raw_output, target || host)
    ]);
    await this.pool.query(
      "INSERT INTO ping_timeout_log_details (log_id, created_ts, status, latency, line) VALUES ?",
      [values]
    );
    return rows.length;
  }

  // Isi snapshot untuk kejadian lama yang sudah pulih tetapi belum punya
  // snapshot (tercatat sebelum fitur snapshot ada), agar detailnya ikut
  // cepat. Berjalan sekali saat start, dibatasi pada kejadian terbaru di
  // dalam masa retensi (di luar itu baris ping_logs-nya memang sudah
  // terhapus) dan jumlahnya dibatasi agar start tidak berat.
  async backfillTimeoutDetailSnapshots(retentionDays, limit = 100) {
    const [logs] = await this.pool.query(
      `SELECT l.id, l.device_id, l.target, l.started_at, l.recovered_at, d.host AS device_host
       FROM ping_timeout_logs l
       JOIN ping_devices d ON d.id = l.device_id
       WHERE l.recovered_at IS NOT NULL
         AND l.started_at >= NOW() - INTERVAL ? DAY
         AND NOT EXISTS (SELECT 1 FROM ping_timeout_log_details s WHERE s.log_id = l.id)
       ORDER BY l.id DESC LIMIT ?`,
      [retentionDays, limit]
    );
    let filled = 0;
    for (const log of logs) {
      try {
        const copied = await this.snapshotTimeoutDetail(log.id, {
          deviceId: log.device_id,
          target: log.target,
          host: log.device_host,
          startedAt: new Date(log.started_at).getTime(),
          endedAt: new Date(log.recovered_at).getTime()
        });
        if (copied > 0) filled += 1;
      } catch (error) {
        console.error(`Gagal backfill snapshot detail #${log.id}:`, error.code || error.message);
      }
    }
    if (filled) console.log(`Snapshot detail log timeout terisi untuk ${filled} kejadian lama.`);
  }

  // Retensi log: ping_logs dan ping_timeout_logs hanya disimpan selama
  // retentionDays hari (default 7, env PING_LOG_RETENTION_DAYS); yang lebih
  // lama dihapus per batch. Umur log timeout dihitung dari waktu mulai
  // kejadian (started_at), jadi baris hilang tepat setelah berumur
  // retentionDays hari — termasuk kejadian yang masih berlangsung.
  async cleanup(retentionDays) {
    let affected;
    do {
      const [result] = await this.pool.query(
        "DELETE FROM ping_logs WHERE created_at < NOW() - INTERVAL ? DAY LIMIT ?",
        [retentionDays, CLEANUP_BATCH]
      );
      affected = result.affectedRows;
    } while (affected === CLEANUP_BATCH);

    try {
      do {
        const [result] = await this.pool.query(
          "DELETE FROM ping_timeout_logs WHERE started_at < NOW() - INTERVAL ? DAY LIMIT ?",
          [retentionDays, CLEANUP_BATCH]
        );
        affected = result.affectedRows;
      } while (affected === CLEANUP_BATCH);
    } catch (error) {
      // Instalasi sangat lama bisa belum punya tabel log timeout.
      if (error.code !== "ER_NO_SUCH_TABLE") throw error;
    }
  }
}

module.exports = new PingWorker(require("../db"));
