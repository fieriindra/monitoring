// Tes sesi tanpa kedaluwarsa: token sesi tidak lagi membawa waktu berakhir,
// jadi token yang ditandatangani server tetap diterima berapa pun umurnya —
// sesi hanya berakhir saat cookie dihapus oleh logout manual.
// Verifikasi dilakukan lewat HTTP: /api/me menolak token tak valid dengan 401
// SEBELUM menyentuh database. Token valid yang lolos verifikasi akan gagal
// belakangan di akses MySQL (503 di lingkungan tes tanpa MySQL), dan itulah
// bukti tokennya diterima.
process.env.SESSION_SECRET = "test-session-secret-minimal-32-karakter!!";
process.env.MYSQL_USER = "test";
process.env.MYSQL_PASSWORD = "test";
process.env.MYSQL_HOST = "127.0.0.1";
process.env.MYSQL_PORT = "1"; // tidak ada MySQL di port ini: koneksi pasti ditolak cepat

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const app = require("../app");

function sign(payload) {
  return crypto.createHmac("sha256", process.env.SESSION_SECRET).update(payload).digest("base64url");
}

async function getMe(base, cookie) {
  const response = await fetch(`${base}/api/me`, { headers: cookie ? { Cookie: cookie } : {} });
  return response.status;
}

test("token sesi format baru (tanpa waktu berakhir) lolos verifikasi kapan pun", async (t) => {
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  // Format baru: "<userId>.<tanda tangan>" — tidak ada komponen waktu sama sekali.
  const newToken = `1.${sign("1")}`;
  assert.equal(newToken.split(".").length, 2);
  assert.equal(await getMe(base, `nadi_session=${encodeURIComponent(newToken)}`), 503);

  // Format lama "<userId>.<expiresAt>.<tanda tangan>" tidak berlaku lagi.
  const oldToken = `1.1.${sign("1.1")}`;
  assert.equal(await getMe(base, `nadi_session=${encodeURIComponent(oldToken)}`), 401);

  // Tanda tangan salah tetap ditolak, dan tanpa cookie tetap 401.
  assert.equal(await getMe(base, `nadi_session=${encodeURIComponent(`1.${sign("2")}`)}`), 401);
  assert.equal(await getMe(base, null), 401);

  // Logout manual menghapus cookie (satu-satunya jalan sesi berakhir).
  const logout = await fetch(`${base}/api/logout`, { method: "POST" });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie") || "", /nadi_session=;.*Max-Age=0/);
});
