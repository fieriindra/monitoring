const { EventEmitter } = require("node:events");
const { Client } = require("ssh2");
const { decrypt } = require("../lib/crypto");
const { parsePing, summarize } = require("../lib/parsers");

const INTERVAL_MS = 1000;
const CONNECT_TIMEOUT_MS = 8000;
const COMMAND_TIMEOUT_MS = 6000;
const MAX_OUTPUT_CHARS = 4000;
const CLEANUP_BATCH = 10000;
const HUAWEI_PROMPT_RE = /(?:<[^>\r\n]+>|\[[^\]\r\n]+\])\s*$/;

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
    const timer = setTimeout(() => reject(new Error("perintah melebihi batas waktu")), COMMAND_TIMEOUT_MS);
    client.exec(command, (error, stream) => {
      if (error) {
        clearTimeout(timer);
        return reject(error);
      }
      let output = "";
      const collect = (chunk) => {
        if (output.length < MAX_OUTPUT_CHARS) output += chunk.toString("utf8");
      };
      stream.on("data", collect);
      stream.stderr.on("data", collect);
      stream.on("close", () => {
        clearTimeout(timer);
        resolve(output);
      });
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
    const timer = setTimeout(() => finish(new Error("perintah shell melebihi batas waktu")), COMMAND_TIMEOUT_MS);
    const onData = (chunk) => {
      if (output.length < MAX_OUTPUT_CHARS) output += chunk.toString("utf8");
      // Selesai ketika statistik ping sudah keluar dan prompt CLI (<...>) muncul kembali.
      if ((/packet loss/i.test(output) || /Error:|Unrecognized|Wrong parameter/i.test(output)) && HUAWEI_PROMPT_RE.test(output)) {
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

  commandFor(target) {
    // Template memakai <IP>; tanpa target (perangkat lama) diganti host perangkat.
    let command = this.device.ping_command.replaceAll("<IP>", target || this.device.host);
    // MikroTik: selipkan src-address= otomatis (diisi manual per perangkat) tepat setelah /ping.
    if (this.device.device_type === "MIKROTIK" && this.device.src_address) {
      command = command.replace(/^(\/ping\s+)/, `$1src-address=${this.device.src_address} `);
    }
    return command;
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
      for (const target of targets) {
        if (this.stopped) break;
        let result = failure;
        if (!result) {
          result = await this.probe(this.commandFor(target));
          if (result.failed) failure = result;
        }
        if (this.stopped) break;
        const output = result.output.slice(0, MAX_OUTPUT_CHARS);
        const { status, latency } = parsePing(output);
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
  }

  // Dipanggil saat aplikasi start. Mencoba ulang sampai MySQL siap.
  async start() {
    this.halted = false;
    while (!this.halted) {
      try {
        await this.reload();
        break;
      } catch (error) {
        console.error("Ping worker belum bisa mulai:", error.code || error.message);
        await sleep(10000);
      }
    }
    if (this.halted || this.cleanupTimer) return;
    const retentionDays = Math.max(1, Number(process.env.PING_LOG_RETENTION_DAYS || 7));
    this.cleanupTimer = setInterval(() => {
      this.cleanup(retentionDays).catch((error) => console.error("Pembersihan ping_logs gagal:", error.code || error.message));
    }, 60 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  stop() {
    this.halted = true;
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    for (const loop of this.loops.values()) loop.stop();
    this.loops.clear();
  }

  // Sinkronkan loop dengan isi ping_devices aktif (urut slot_order). Dipanggil setelah tambah/hapus.
  async reload() {
    const [rows] = await this.pool.execute(
      "SELECT id, label, host, port, username, password, device_type, ping_command, src_address FROM ping_devices WHERE is_active = 1 ORDER BY slot_order, id"
    );
    const [targetRows] = await this.pool.execute("SELECT device_id, target FROM ping_targets ORDER BY device_id, position, id");
    const targetsByDevice = new Map();
    for (const { device_id: deviceId, target } of targetRows) {
      if (!targetsByDevice.has(deviceId)) targetsByDevice.set(deviceId, []);
      targetsByDevice.get(deviceId).push(target);
    }
    const wanted = new Map(rows.map((row) => [row.id, row]));

    for (const [id, loop] of this.loops) {
      if (!wanted.has(id)) {
        loop.stop();
        this.loops.delete(id);
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
  }

  async cleanup(retentionDays) {
    let affected;
    do {
      const [result] = await this.pool.query(
        "DELETE FROM ping_logs WHERE created_at < NOW() - INTERVAL ? DAY LIMIT ?",
        [retentionDays, CLEANUP_BATCH]
      );
      affected = result.affectedRows;
    } while (affected === CLEANUP_BATCH);
  }
}

module.exports = new PingWorker(require("../db"));
