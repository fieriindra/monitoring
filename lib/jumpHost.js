// Konfigurasi jump host (SSH berantai) khusus per perangkat.
//
// Sebagian perangkat tidak bisa dijangkau langsung dari server aplikasi,
// tetapi bisa dicapai dari perangkat jaringan lain yang sudah terjangkau.
// Untuk perangkat seperti itu admin dapat memasang SATU baris konfigurasi
// di tabel ping_device_jump_hosts (dikelola langsung di basis data — tidak
// ada antarmuka web/API untuk ini). Worker lalu menyambung SSH dulu ke
// jump host, dan dari shell jump host membuka SSH bersarang ke perangkat
// tujuan (perintah "system ssh" RouterOS pada jump host MikroTik).
//
// Baris konfigurasi terikat ke perangkat lewat FOREIGN KEY ON DELETE
// CASCADE: menghapus perangkat ikut menghapus konfigurasi khususnya.
//
// Saat ini jalur bersarang hanya didukung untuk perangkat HUAWEI
// (shell interaktif persisten). Lihat workers/pingWorker.js.

// Token aman untuk disisipkan ke perintah konsol RouterOS tanpa risiko
// memecah perintah (spasi, ";", "|", dsb. ditolak).
const SAFE_TOKEN_RE = /^[A-Za-z0-9._-]+$/;
// Host/IP tujuan: huruf, angka, titik, strip, titik dua (IPv6), garis bawah.
const HOST_RE = /^[A-Za-z0-9._:-]+$/;

function invalid(message) {
  const error = new TypeError(`Konfigurasi jump host tidak valid: ${message}`);
  error.code = "INVALID_JUMP_CONFIG";
  return error;
}

// Normalisasi + validasi satu baris ping_device_jump_hosts (atau null bila
// tidak ada baris). Mengembalikan { deviceId, host, port, username,
// passwordCipher } — password masih dalam bentuk terenkripsi.
function normalizeJumpConfig(row) {
  if (!row) return null;
  const deviceId = Number(row.device_id);
  if (!Number.isInteger(deviceId) || deviceId <= 0) throw invalid("device_id kosong");
  const host = String(row.jump_host ?? "").trim();
  if (!host || !HOST_RE.test(host)) throw invalid("jump_host kosong/berkarakter aneh");
  const port = row.jump_port === null || row.jump_port === undefined || row.jump_port === ""
    ? 22
    : Number(row.jump_port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw invalid("jump_port di luar 1-65535");
  const username = String(row.jump_username ?? "").trim();
  if (!username || !SAFE_TOKEN_RE.test(username)) throw invalid("jump_username kosong/berkarakter aneh");
  const passwordCipher = String(row.jump_password ?? "");
  if (!passwordCipher) throw invalid("jump_password kosong");
  return { deviceId, host, port, username, passwordCipher };
}

// Perintah RouterOS untuk membuka SSH bersarang dari shell jump host ke
// perangkat tujuan. Port hanya ditulis bila bukan default 22 — bentuk
// perintah yang paling umum sengaja dibuat persis seperti yang diketik
// manual di konsol.
function buildNestedSshCommand(device) {
  const host = String(device && device.host ? device.host : "").trim();
  if (!host || !HOST_RE.test(host)) throw invalid("host perangkat kosong/berkarakter aneh");
  const username = String(device && device.username ? device.username : "").trim();
  if (!username || !SAFE_TOKEN_RE.test(username)) throw invalid("username perangkat kosong/berkarakter aneh");
  const port = Number(device.port || 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw invalid("port perangkat di luar 1-65535");
  let command = `/system ssh address=${host} user=${username}`;
  if (port !== 22) command += ` port=${port}`;
  return command;
}

module.exports = { normalizeJumpConfig, buildNestedSshCommand };
