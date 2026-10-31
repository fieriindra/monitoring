// Tes LOG TIMEOUT (lib/timeoutTracker.js): rangkaian RTO/timeout berurutan
// baru tercatat setelah umurnya mencapai ambang (default 3 detik), tercatat
// tepat satu kali per rangkaian, dan dilengkapi durasi saat kembali UP.
const test = require("node:test");
const assert = require("node:assert/strict");

const { TimeoutTracker } = require("../lib/timeoutTracker");

test("di bawah ambang (3 detik) tidak ada yang tercatat", () => {
  const tracker = new TimeoutTracker();
  assert.equal(tracker.feed("1|8.8.8.8", "TIMEOUT", 0, 3), null);
  assert.equal(tracker.feed("1|8.8.8.8", "TIMEOUT", 1000, 3), null);
  assert.equal(tracker.feed("1|8.8.8.8", "TIMEOUT", 2000, 3), null);
  // Pulih sebelum mencapai ambang: tidak ada event recover juga.
  assert.equal(tracker.feed("1|8.8.8.8", "UP", 2500, 3), null);
});

test("mencapai ambang: record tepat satu kali, lalu recover membawa durasi total", () => {
  const tracker = new TimeoutTracker();
  tracker.feed("1|8.8.8.8", "TIMEOUT", 0, 3);
  tracker.feed("1|8.8.8.8", "TIMEOUT", 1000, 3);
  tracker.feed("1|8.8.8.8", "TIMEOUT", 2000, 3);

  const record = tracker.feed("1|8.8.8.8", "TIMEOUT", 3000, 3);
  assert.equal(record.type, "record");
  assert.equal(record.startedAt, 0);
  assert.equal(record.recordedAt, 3000);
  assert.equal(record.timeoutCount, 4);

  // TIMEOUT berikutnya dalam rangkaian yang sama tidak mencatat ulang.
  assert.equal(tracker.feed("1|8.8.8.8", "TIMEOUT", 4000, 3), null);
  assert.equal(tracker.feed("1|8.8.8.8", "TIMEOUT", 5000, 3), null);

  const recover = tracker.feed("1|8.8.8.8", "UP", 6000, 3);
  assert.equal(recover.type, "recover");
  assert.equal(recover.startedAt, 0);
  assert.equal(recover.endedAt, 6000);
  assert.equal(recover.durationSeconds, 6);
  assert.equal(recover.timeoutCount, 6);

  // Setelah pulih, rangkaian baru bisa tercatat lagi dari awal.
  assert.equal(tracker.feed("1|8.8.8.8", "TIMEOUT", 10000, 3), null);
  const record2 = tracker.feed("1|8.8.8.8", "TIMEOUT", 13000, 3);
  assert.equal(record2.type, "record");
  assert.equal(record2.startedAt, 10000);
});

test("ambang bisa diubah dan berlaku pada rangkaian yang sedang berjalan", () => {
  const tracker = new TimeoutTracker();
  tracker.feed("2|1.1.1.1", "TIMEOUT", 0, 30);
  // Dengan ambang 30 detik, 10 detik belum tercatat...
  assert.equal(tracker.feed("2|1.1.1.1", "TIMEOUT", 10000, 30), null);
  // ...tetapi begitu ambang diturunkan ke 3 detik, hasil berikutnya langsung tercatat.
  const record = tracker.feed("2|1.1.1.1", "TIMEOUT", 11000, 3);
  assert.equal(record.type, "record");
  assert.equal(record.startedAt, 0);
});

test("ambang bawaan adalah 3 detik bila tidak diberikan", () => {
  const tracker = new TimeoutTracker();
  tracker.feed("3|9.9.9.9", "TIMEOUT", 0);
  assert.equal(tracker.feed("3|9.9.9.9", "TIMEOUT", 2999), null);
  assert.equal(tracker.feed("3|9.9.9.9", "TIMEOUT", 3000).type, "record");
});

test("rangkaian tiap perangkat+tujuan dilacak terpisah", () => {
  const tracker = new TimeoutTracker();
  tracker.feed("1|8.8.8.8", "TIMEOUT", 0, 3);
  tracker.feed("1|1.1.1.1", "TIMEOUT", 0, 3);
  // Tujuan pertama pulih di bawah ambang; yang kedua tetap berjalan dan tercatat.
  assert.equal(tracker.feed("1|8.8.8.8", "UP", 1000, 3), null);
  assert.equal(tracker.feed("1|1.1.1.1", "TIMEOUT", 3000, 3).type, "record");
  // UP tanpa rangkaian apa pun tidak menghasilkan event.
  assert.equal(tracker.feed("9|tidak-ada", "UP", 5000, 3), null);
});

test("markUnrecorded mengizinkan record terbit lagi setelah gagal simpan", () => {
  const tracker = new TimeoutTracker();
  tracker.feed("4|8.8.4.4", "TIMEOUT", 0, 3);
  assert.equal(tracker.feed("4|8.8.4.4", "TIMEOUT", 3000, 3).type, "record");
  tracker.markUnrecorded("4|8.8.4.4");
  const retry = tracker.feed("4|8.8.4.4", "TIMEOUT", 4000, 3);
  assert.equal(retry.type, "record");
  assert.equal(retry.startedAt, 0);
  assert.equal(retry.timeoutCount, 3);
});

test("satu hasil TIMEOUT yang disusul jeda panjang langsung tercatat (umur rangkaian yang dihitung)", () => {
  const tracker = new TimeoutTracker();
  tracker.feed("5|8.8.8.8", "TIMEOUT", 0, 3);
  // Hasil berikutnya baru datang 20 detik kemudian (mis. perintah ping lama):
  // umur rangkaian sudah jauh melewati ambang, jadi langsung tercatat.
  const record = tracker.feed("5|8.8.8.8", "TIMEOUT", 20000, 3);
  assert.equal(record.type, "record");
  assert.equal(record.timeoutCount, 2);
});
