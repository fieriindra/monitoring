require("dotenv").config();

const crypto = require("node:crypto");
const path = require("node:path");
const express = require("express");
const bcrypt = require("bcryptjs");
const http = require("node:http");
const { WebSocketServer } = require("ws");
const pool = require("./db");
const pingWorker = require("./workers/pingWorker");
const createPingRouter = require("./routes/ping");
const createPrtgRouter = require("./routes/prtg");
const createReorderRouter = require("./routes/reorder");
const createDisplaySettingsRouter = require("./routes/displaySettings");

const app = express();
const port = Number(process.env.PORT || 3000);
const sessionSecret = process.env.SESSION_SECRET;
const cookieName = "nadi_session";
// Sesi TIDAK memiliki masa kedaluwarsa: pengguna hanya keluar saat logout manual.
// Token sesi tidak membawa waktu berakhir, dan Max-Age cookie diatur ke batas
// persisten maksimum browser (400 hari, batas Chrome/RFC 6265bis) lalu diperbarui
// secara geser (sliding) pada setiap request terautentikasi, sehingga selama
// aplikasi dipakai sesi tidak pernah mencapai batas tersebut.
const sessionCookieMaxAgeSeconds = 400 * 24 * 60 * 60;
const databaseConfigurationError = "MySQL belum dikonfigurasi. Isi MYSQL_USER dan MYSQL_PASSWORD di file .env.";
const sessionConfigurationError = "SESSION_SECRET belum dikonfigurasi. Isi secret minimal 32 karakter di file .env.";

app.disable("x-powered-by");
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public"), { index: false }));

function signSession(userId) {
  const payload = `${userId}`;
  const signature = crypto.createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifySession(token) {
  if (typeof token !== "string" || !sessionSecret || sessionSecret.length < 32) return null;

  const [userIdText, signature, ...extra] = token.split(".");
  if (extra.length || !/^\d+$/.test(userIdText) || !signature) return null;

  const userId = Number(userIdText);
  if (!Number.isSafeInteger(userId)) return null;

  const expected = crypto.createHmac("sha256", sessionSecret)
    .update(`${userId}`)
    .digest();
  let received;
  try {
    received = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;
  return userId;
}

// Tulis (atau perbarui) cookie sesi. Dipanggil saat login dan pada setiap
// request terautentikasi agar Max-Age cookie selalu mulai dari awal.
function setSessionCookie(response, userId) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `${cookieName}=${encodeURIComponent(signSession(userId))}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionCookieMaxAgeSeconds}${secure}`
  );
}

function readCookie(request, name) {
  const cookieHeader = request.headers.cookie || "";
  for (const entry of cookieHeader.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0 || entry.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(entry.slice(separator + 1).trim());
  }
  return null;
}

function checkDatabaseConfiguration() {
  if (!process.env.MYSQL_USER || !process.env.MYSQL_PASSWORD) {
    const error = new Error(databaseConfigurationError);
    error.code = "APP_DATABASE_NOT_CONFIGURED";
    throw error;
  }
}

async function getSessionUser(request) {
  checkDatabaseConfiguration();
  const userId = verifySession(readCookie(request, cookieName));
  if (!userId) return null;

  const [users] = await pool.execute(
    "SELECT id, username FROM users WHERE id = ? LIMIT 1",
    [userId]
  );
  return users[0] || null;
}

async function requirePageSession(request, response, next) {
  try {
    const user = await getSessionUser(request);
    if (!user) return response.redirect("/");
    setSessionCookie(response, user.id);
    response.locals.username = user.username;
    return next();
  } catch (error) {
    return next(error);
  }
}

async function requireApiSession(request, response, next) {
  try {
    const user = await getSessionUser(request);
    if (!user) return response.status(401).json({ error: "Sesi tidak valid." });
    setSessionCookie(response, user.id);
    request.user = user;
    return next();
  } catch (error) {
    return next(error);
  }
}

app.use("/api/ping", createPingRouter({ pool, requireApiSession, worker: pingWorker }));
app.use("/api/prtg", createPrtgRouter({ pool, requireApiSession }));
app.use("/api/reorder", createReorderRouter({ pool, requireApiSession }));
app.use("/api/display-settings", createDisplaySettingsRouter({ pool, requireApiSession }));

app.get("/", async (request, response, next) => {
  try {
    if (await getSessionUser(request)) return response.redirect("/menu");
    return response.sendFile(path.join(__dirname, "index.html"));
  } catch (error) {
    if (error.code === "APP_DATABASE_NOT_CONFIGURED") {
      return response.sendFile(path.join(__dirname, "index.html"));
    }
    if (["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "ER_ACCESS_DENIED_ERROR", "ER_BAD_DB_ERROR", "PROTOCOL_CONNECTION_LOST"].includes(error.code)) {
      console.error("Tidak dapat memeriksa sesi karena MySQL belum tersedia:", error.message);
      return response.sendFile(path.join(__dirname, "index.html"));
    }
    return next(error);
  }
});

app.get("/menu", requirePageSession, (_request, response) => {
  response.sendFile(path.join(__dirname, "dashboard.html"));
});

app.get("/ping-monitoring", requirePageSession, (_request, response) => {
  response.sendFile(path.join(__dirname, "ping-monitoring.html"));
});

app.get("/prtg-monitoring", requirePageSession, (_request, response) => {
  response.sendFile(path.join(__dirname, "prtg-monitoring.html"));
});

app.get("/login", (_request, response) => {
  response.sendFile(path.join(__dirname, "index.html"));
});

app.get("/ganti-password", requirePageSession, (_request, response) => {
  response.sendFile(path.join(__dirname, "ganti-password.html"));
});

app.post("/api/login", async (request, response, next) => {
  try {
    checkDatabaseConfiguration();
    if (!sessionSecret || sessionSecret.length < 32) {
      return response.status(503).json({ error: sessionConfigurationError });
    }

    const body = request.body && typeof request.body === "object" ? request.body : {};
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!/^[A-Za-z0-9._-]{1,64}$/.test(username) || !password || Buffer.byteLength(password, "utf8") > 72) {
      return response.status(400).json({ error: "Username atau kata sandi tidak valid." });
    }

    const [users] = await pool.execute(
      "SELECT id, username, password_hash FROM users WHERE username = ? LIMIT 1",
      [username]
    );
    const user = users[0];
    const passwordMatches = user ? await bcrypt.compare(password, user.password_hash) : false;

    if (!passwordMatches) {
      return response.status(401).json({ error: "Username atau kata sandi salah." });
    }

    setSessionCookie(response, user.id);
    return response.json({ username: user.username, redirect: "/menu" });
  } catch (error) {
    return next(error);
  }
});

app.get("/api/me", async (request, response, next) => {
  try {
    const user = await getSessionUser(request);
    if (!user) return response.status(401).json({ error: "Sesi tidak valid." });
    setSessionCookie(response, user.id);
    return response.json({ username: user.username });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/change-password", requireApiSession, async (request, response, next) => {
  try {
    const body = request.body && typeof request.body === "object" ? request.body : {};
    const currentPassword = typeof body.current_password === "string" ? body.current_password : "";
    const newPassword = typeof body.new_password === "string" ? body.new_password : "";
    const newBytes = Buffer.byteLength(newPassword, "utf8");
    if (!currentPassword || newBytes < 8 || newBytes > 72) {
      return response.status(400).json({ error: "Kata sandi baru harus 8-72 karakter." });
    }

    const [users] = await pool.execute(
      "SELECT id, password_hash FROM users WHERE id = ? LIMIT 1",
      [request.user.id]
    );
    const user = users[0];
    const passwordMatches = user ? await bcrypt.compare(currentPassword, user.password_hash) : false;
    if (!passwordMatches) {
      return response.status(401).json({ error: "Kata sandi saat ini salah." });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await pool.execute("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, request.user.id]);
    return response.json({ ok: true, message: "Kata sandi berhasil diganti." });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/logout", (_request, response) => {
  response.setHeader(
    "Set-Cookie",
    `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${process.env.NODE_ENV === "production" ? "; Secure" : ""}`
  );
  return response.json({ redirect: "/" });
});

app.use((error, _request, response, _next) => {
  if (error.code === "APP_VALIDATION") {
    return response.status(400).json({ error: error.message });
  }
  if (error.code === "APP_UPSTREAM") {
    return response.status(502).json({ error: error.message });
  }
  if (error.status >= 400 && error.status < 500) {
    return response.status(error.status).json({ error: "Permintaan tidak valid." });
  }
  console.error("Request gagal:", error.code || error.message || error);
  if (error.code === "APP_ENCRYPTION_NOT_CONFIGURED") {
    return response.status(503).json({ error: error.message });
  }
  if (error.code === "APP_DATABASE_NOT_CONFIGURED") {
    return response.status(503).json({ error: error.message });
  }
  if (["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "ER_ACCESS_DENIED_ERROR", "ER_BAD_DB_ERROR", "PROTOCOL_CONNECTION_LOST"].includes(error.code)) {
    return response.status(503).json({ error: "Tidak dapat terhubung ke MySQL. Periksa apakah MySQL berjalan dan pengaturan .env sudah benar." });
  }
  response.status(500).json({ error: "Terjadi kesalahan pada server." });
});

// WebSocket /ws/ping: hanya untuk pengguna yang sudah login (cookie sesi SameSite=Strict).
function attachPingWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (request, socket, head) => {
    try {
      const { pathname } = new URL(request.url, "http://localhost");
      if (pathname !== "/ws/ping") return socket.destroy();
      const user = await getSessionUser(request);
      if (!user) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return socket.destroy();
      }
      return wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
    } catch {
      return socket.destroy();
    }
  });

  pingWorker.on("result", (result) => {
    if (!wss.clients.size) return;
    const message = JSON.stringify({ type: "ping", ...result });
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(message);
    }
  });
}

async function start() {
  const server = http.createServer(app);
  attachPingWebSocket(server);
  server.listen(port, () => {
    console.log(`Monitoring berjalan di http://localhost:${port}`);
    if (!process.env.MYSQL_USER || !process.env.MYSQL_PASSWORD) {
      console.warn(databaseConfigurationError);
      return;
    }
    pool.query("SELECT 1").catch((error) => {
      console.error("MySQL belum tersedia; halaman login tetap aktif:", error.code || error.message || error);
    });
    pingWorker.start().catch((error) => console.error("Ping worker gagal dimulai:", error.message));
  });
}

if (require.main === module) {
  start().catch((error) => {
    console.error("Gagal menjalankan server:", error.message);
    process.exitCode = 1;
  });
}

module.exports = app;
