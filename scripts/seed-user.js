require("dotenv").config();

const bcrypt = require("bcryptjs");
const pool = require("../db");

const username = "NOC";
const password = process.env.NOC_PASSWORD;

async function createInitialUser() {
  if (!process.env.MYSQL_USER || !process.env.MYSQL_PASSWORD) {
    throw new Error("Atur MYSQL_USER dan MYSQL_PASSWORD di file .env terlebih dahulu.");
  }
  if (!password || Buffer.byteLength(password, "utf8") < 8 || Buffer.byteLength(password, "utf8") > 72) {
    throw new Error("Atur NOC_PASSWORD dengan panjang 8 sampai 72 byte di environment.");
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await pool.execute(
    "INSERT INTO users (username, password_hash) VALUES (?, ?)",
    [username, passwordHash]
  );
  console.log(`User ${username} berhasil dibuat.`);
}

createInitialUser()
  .catch((error) => {
    if (error.code === "ER_DUP_ENTRY") {
      console.error(`User ${username} sudah ada. Seeder tidak mengubah kata sandi yang tersimpan.`);
    } else {
      console.error("Gagal membuat user:", error.code || error.message || error);
    }
    process.exitCode = 1;
  })
  .finally(() => pool.end());
