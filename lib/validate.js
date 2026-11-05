const { LOGICAL_SYSTEM_PATTERN } = require("./pingCommand");

const MAX_SLOTS = 240; // Cukup untuk 15 slide @ 16 kolom (lihat display_settings / slots_per_page).
const MAX_TARGETS_PER_DEVICE = 6;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const TARGET_PATTERN = /^[A-Za-z0-9.:-]+$/;

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.code = "APP_VALIDATION";
    this.status = 400;
  }
}

function text(body, key, { label, max, trim = true, pattern, patternMessage, optional = false }) {
  const raw = typeof body[key] === "string" ? body[key] : "";
  const value = trim ? raw.trim() : raw;
  if (!value) {
    if (optional) return null;
    throw new ValidationError(`${label} wajib diisi (maksimal ${max} karakter).`);
  }
  if (value.length > max) throw new ValidationError(`${label} wajib diisi (maksimal ${max} karakter).`);
  if (CONTROL_CHARS.test(value)) throw new ValidationError(`${label} mengandung karakter tidak valid.`);
  if (pattern && !pattern.test(value)) throw new ValidationError(patternMessage || `${label} tidak valid.`);
  return value;
}

function integer(body, key, { label, min, max, fallback }) {
  let raw = body[key];
  if ((raw === undefined || raw === null || raw === "") && fallback !== undefined) return fallback;
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) raw = Number(raw.trim());
  if (!Number.isInteger(raw) || raw < min || raw > max) {
    throw new ValidationError(`${label} harus bilangan bulat ${min}-${max}.`);
  }
  return raw;
}

function oneOf(body, key, { label, values, fallback }) {
  const value = body[key] === undefined || body[key] === "" ? fallback : body[key];
  if (!values.includes(value)) throw new ValidationError(`${label} harus salah satu dari: ${values.join(", ")}.`);
  return value;
}

function positiveId(value) {
  const id = Number(value);
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(id) || id < 1) {
    throw new ValidationError("ID tidak valid.");
  }
  return id;
}

// Seperti text(), tapi boleh dikosongkan (mis. password saat edit: kosong = tidak diubah).
// Mengembalikan null bila kosong, atau string tervalidasi.
function optionalSecret(body, key, { label, max }) {
  const raw = typeof body[key] === "string" ? body[key] : "";
  if (!raw) return null;
  if (raw.length > max) throw new ValidationError(`${label} maksimal ${max} karakter.`);
  if (CONTROL_CHARS.test(raw)) throw new ValidationError(`${label} mengandung karakter tidak valid.`);
  return raw;
}

// Parse satu entri target: bisa berupa string "8.8.8.8", "8.8.8.8 | Nama Kolom",
// "Nama Kolom | 8.8.8.8", atau objek { target, label, logical_system }.
// Logical-system (khusus Juniper) ditulis sebagai segmen "ls=NAMA" pada bentuk
// string, atau field logical_system pada bentuk objek. Nilai logical_system
// hasil parse: nama (string), null (dikirim tapi kosong), atau undefined
// (bentuk objek yang tidak mengirim field ini — pemanggil boleh
// mempertahankan nilai yang sudah tersimpan).
function parseTargetEntry(entry, fieldLabel) {
  let target = "";
  let customLabel = null;
  let logicalSystem = null;

  if (entry && typeof entry === "object") {
    target = typeof entry.target === "string" ? entry.target.trim() : "";
    customLabel = typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : null;
    if (!("logical_system" in entry)) {
      logicalSystem = undefined;
    } else if (typeof entry.logical_system === "string" && entry.logical_system.trim()) {
      logicalSystem = entry.logical_system.trim();
    }
  } else if (typeof entry === "string") {
    const trimmed = entry.trim();
    if (!trimmed) return null;
    const rest = [];
    for (const segment of trimmed.split("|").map((part) => part.trim())) {
      const lsMatch = segment.match(/^ls=(.*)$/i);
      if (lsMatch) logicalSystem = lsMatch[1].trim() || null;
      else if (segment) rest.push(segment);
    }
    if (!rest.length) return null;
    if (rest.length === 1) {
      target = rest[0];
    } else {
      const a = rest[0];
      const b = rest.slice(1).join("|").trim();
      // Deteksi mana yang IP/host valid dan mana yang nama custom
      if (TARGET_PATTERN.test(a) && (!TARGET_PATTERN.test(b) || /^\d/.test(a))) {
        target = a;
        customLabel = b || null;
      } else {
        target = b;
        customLabel = a || null;
      }
    }
  } else {
    return null;
  }

  if (!target) return null;
  if (target.length > 100 || !TARGET_PATTERN.test(target)) {
    throw new ValidationError(`${fieldLabel} "${target}" hanya boleh berisi huruf, angka, titik, titik dua, dan strip (maksimal 100 karakter).`);
  }
  if (customLabel !== null) {
    if (customLabel.length > 100 || CONTROL_CHARS.test(customLabel)) {
      throw new ValidationError(`Nama kolom pada target "${target}" tidak valid (maksimal 100 karakter).`);
    }
  }
  if (logicalSystem !== null && logicalSystem !== undefined && !LOGICAL_SYSTEM_PATTERN.test(logicalSystem)) {
    throw new ValidationError(`Logical system pada target "${target}" hanya boleh berisi huruf, angka, titik, strip, dan garis bawah (maksimal 64 karakter).`);
  }
  return { target, label: customLabel, logical_system: logicalSystem };
}

// Daftar target IP/host (0..MAX_TARGETS_PER_DEVICE) beserta opsional custom label per kolom.
function targetList(body, key, { label }) {
  const raw = body[key];
  if (raw === undefined || raw === null || raw === "") return [];
  const items = Array.isArray(raw) ? raw : String(raw).split(/\r?\n/);
  const seen = new Set();
  const result = [];
  for (const entry of items) {
    const parsed = parseTargetEntry(entry, label);
    if (!parsed) continue;
    if (seen.has(parsed.target)) continue;
    seen.add(parsed.target);
    result.push(parsed);
  }
  if (result.length > MAX_TARGETS_PER_DEVICE) {
    throw new ValidationError(`${label} maksimal ${MAX_TARGETS_PER_DEVICE} tujuan per perangkat.`);
  }
  return result;
}

// Slot terkecil (1..MAX_SLOTS) yang belum dipakai. `table` hanya dari daftar tetap, bukan input pengguna.
async function nextFreeSlot(pool, table) {
  if (!["ping_devices", "prtg_sensors"].includes(table)) throw new Error("Tabel tidak dikenal.");
  const [rows] = await pool.query(`SELECT slot_order FROM ${table}`);
  const used = new Set(rows.map((row) => row.slot_order));
  for (let slot = 1; slot <= MAX_SLOTS; slot += 1) {
    if (!used.has(slot)) return slot;
  }
  throw new ValidationError(`Semua ${MAX_SLOTS} slot sudah terpakai. Hapus salah satu data terlebih dahulu.`);
}

module.exports = { MAX_SLOTS, MAX_TARGETS_PER_DEVICE, ValidationError, text, integer, oneOf, positiveId, optionalSecret, targetList, nextFreeSlot };
