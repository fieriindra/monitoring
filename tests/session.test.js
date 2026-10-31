// Tes fitur "Ingat saya": token sesi tidak membawa waktu berakhir, tetapi
// membawa penanda sifat sesi — "r" untuk "Ingat saya" (cookie persisten
// Max-Age 400 hari) dan "s" untuk sesi biasa (cookie sesi tanpa Max-Age,
// terhapus saat browser ditutup). Token format lama "<userId>.<tanda tangan>"
// tetap diterima dan diperlakukan sebagai "Ingat saya".
// Verifikasi HTTP dilakukan lewat /api/me: token tak valid ditolak 401
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
const { signSession, verifySession, setSessionCookie, sessionCookieMaxAgeSeconds } = app.sessionHelpers;

function sign(payload) {
  return crypto.createHmac("sha256", process.env.SESSION_SECRET).update(payload).digest("base64url");
}

async function getMe(base, cookie) {
  const response = await fetch(`${base}/api/me`, { headers: cookie ? { Cookie: cookie } : {} });
  return response.status;
}

function fakeResponse() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
  };
}

test("token sesi (lama dan baru) lolos verifikasi kapan pun, format kedaluwarsa ditolak", async (t) => {
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  // Format lama: "<userId>.<tanda tangan>" — tidak ada komponen waktu sama sekali.
  const legacyToken = `1.${sign("1")}`;
  assert.equal(legacyToken.split(".").length, 2);
  assert.equal(await getMe(base, `nadi_session=${encodeURIComponent(legacyToken)}`), 503);

  // Format baru dengan penanda "Ingat saya" ("r") dan sesi biasa ("s").
  const rememberToken = `1.r.${sign("1.r")}`;
  assert.equal(await getMe(base, `nadi_session=${encodeURIComponent(rememberToken)}`), 503);
  const sessionToken = `1.s.${sign("1.s")}`;
  assert.equal(await getMe(base, `nadi_session=${encodeURIComponent(sessionToken)}`), 503);

  // Format lama berkedaluwarsa "<userId>.<expiresAt>.<tanda tangan>" tidak berlaku:
  // komponen tengahnya bukan penanda "r"/"s" yang dikenal.
  const oldToken = `1.1.${sign("1.1")}`;
  assert.equal(await getMe(base, `nadi_session=${encodeURIComponent(oldToken)}`), 401);

  // Penanda yang dipalsukan (tanda tangan untuk "s" dipakai pada token "r") ditolak.
  const forgedToken = `1.r.${sign("1.s")}`;
  assert.equal(await getMe(base, `nadi_session=${encodeURIComponent(forgedToken)}`), 401);

  // Tanda tangan salah tetap ditolak, dan tanpa cookie tetap 401.
  assert.equal(await getMe(base, `nadi_session=${encodeURIComponent(`1.${sign("2")}`)}`), 401);
  assert.equal(await getMe(base, null), 401);

  // Logout manual menghapus cookie (jalan sesi "Ingat saya" berakhir).
  const logout = await fetch(`${base}/api/logout`, { method: "POST" });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie") || "", /nadi_session=;.*Max-Age=0/);
});

test("signSession/verifySession mempertahankan pilihan Ingat saya", () => {
  const rememberToken = signSession(7, true);
  assert.equal(rememberToken.split(".")[1], "r");
  assert.deepEqual(verifySession(rememberToken), { userId: 7, remember: true });

  const sessionToken = signSession(7, false);
  assert.equal(sessionToken.split(".")[1], "s");
  assert.deepEqual(verifySession(sessionToken), { userId: 7, remember: false });

  // Token lama tanpa penanda diperlakukan sebagai "Ingat saya".
  assert.deepEqual(verifySession(`7.${sign("7")}`), { userId: 7, remember: true });

  // Token rusak/tidak dikenal ditolak.
  assert.equal(verifySession("bukan-token"), null);
  assert.equal(verifySession(`7.x.${sign("7.x")}`), null);
  assert.equal(verifySession(""), null);
});

test("setSessionCookie: Ingat saya persisten 400 hari, sesi biasa tanpa Max-Age", () => {
  const remembered = fakeResponse();
  setSessionCookie(remembered, 7, true);
  const rememberedHeader = remembered.headers["Set-Cookie"];
  assert.match(rememberedHeader, new RegExp(`Max-Age=${sessionCookieMaxAgeSeconds}`));
  assert.equal(sessionCookieMaxAgeSeconds, 400 * 24 * 60 * 60);
  assert.match(rememberedHeader, /HttpOnly/);
  assert.ok(decodeURIComponent(rememberedHeader.split(";")[0].split("=")[1]).startsWith("7.r."));

  const plain = fakeResponse();
  setSessionCookie(plain, 7, false);
  const plainHeader = plain.headers["Set-Cookie"];
  assert.doesNotMatch(plainHeader, /Max-Age/);
  assert.doesNotMatch(plainHeader, /Expires/);
  assert.match(plainHeader, /HttpOnly/);
  assert.ok(decodeURIComponent(plainHeader.split(";")[0].split("=")[1]).startsWith("7.s."));
});
