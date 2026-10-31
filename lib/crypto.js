const crypto = require("node:crypto");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getKey() {
  const hex = process.env.DATA_ENCRYPTION_KEY || "";
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    const error = new Error("DATA_ENCRYPTION_KEY belum dikonfigurasi. Isi 64 karakter hex di file .env.");
    error.code = "APP_ENCRYPTION_NOT_CONFIGURED";
    throw error;
  }
  return Buffer.from(hex, "hex");
}

// Format hasil: base64(iv[12] | authTag[16] | ciphertext)
function encrypt(plainText) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

function decrypt(payload) {
  const buffer = Buffer.from(String(payload), "base64");
  if (buffer.length < IV_LENGTH + TAG_LENGTH) throw new Error("Data terenkripsi tidak valid.");
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), buffer.subarray(0, IV_LENGTH));
  decipher.setAuthTag(buffer.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH));
  return Buffer.concat([decipher.update(buffer.subarray(IV_LENGTH + TAG_LENGTH)), decipher.final()]).toString("utf8");
}

module.exports = { encrypt, decrypt };
