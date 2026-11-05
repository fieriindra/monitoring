"use strict";

// Membangun perintah ping final untuk satu tujuan dari template perintah
// perangkat. Template memuat placeholder <IP> yang diganti IP tujuan (atau
// host perangkat untuk perangkat tanpa tujuan khusus).
//
// Khusus JUNIPER: tujuan boleh diarahkan ke sebuah logical-system — nama
// logical-system diselipkan sebagai opsi Junos "logical-system <nama>" tepat
// sebelum IP, sehingga ping berjalan memakai tabel routing logical-system
// tersebut. Nama divalidasi ulang di sini (pola ketat) agar nilai apa pun
// yang tersimpan di database tidak bisa menyuntikkan perintah tambahan.
//
// Khusus MikroTik: src-address= diselipkan tepat setelah /ping bila diisi.

const LOGICAL_SYSTEM_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function buildPingCommand(device, entry) {
  const ip = entry && entry.ip ? entry.ip : null;
  const host = ip || device.host;
  let replacement = host;
  if (
    device.device_type === "JUNIPER" &&
    entry &&
    entry.logicalSystem &&
    LOGICAL_SYSTEM_PATTERN.test(entry.logicalSystem)
  ) {
    replacement = `logical-system ${entry.logicalSystem} ${host}`;
  }
  let command = String(device.ping_command || "").replaceAll("<IP>", replacement);
  if (device.device_type === "MIKROTIK" && device.src_address) {
    command = command.replace(/^(\/ping\s+)/, `$1src-address=${device.src_address} `);
  }
  return command;
}

module.exports = { buildPingCommand, LOGICAL_SYSTEM_PATTERN };
