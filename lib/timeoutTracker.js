// Pelacak RTO/timeout berurutan per perangkat+tujuan untuk LOG TIMEOUT.
//
// Setiap hasil ping dari worker dimasukkan lewat feed(). Rangkaian TIMEOUT
// dimulai pada hasil TIMEOUT pertama; begitu umur rangkaian mencapai ambang
// (thresholdSeconds, default 3 detik) feed() mengembalikan event "record"
// tepat satu kali — saat itulah worker menulis baris log ke MySQL. Bila
// rangkaian kemudian berakhir dengan hasil UP, feed() mengembalikan event
// "recover" (hanya untuk rangkaian yang sempat tercatat) agar baris log yang
// sama dilengkapi waktu pulih dan durasi totalnya. Rangkaian yang belum
// mencapai ambang tidak menghasilkan event apa pun.
//
// Kelas ini murni logika (tanpa DB/jaringan) agar bisa diuji unit; waktu
// diberikan pemanggil dalam milidetik epoch.
class TimeoutTracker {
  constructor() {
    this.streaks = new Map();
  }

  // Mengembalikan event { type: "record" | "recover", ... } atau null.
  feed(key, status, atMs, thresholdSeconds) {
    if (status !== "TIMEOUT") {
      const streak = this.streaks.get(key);
      if (!streak) return null;
      this.streaks.delete(key);
      if (!streak.recorded) return null;
      return {
        type: "recover",
        key,
        startedAt: streak.startedAt,
        endedAt: atMs,
        durationSeconds: Math.max(0, Math.round((atMs - streak.startedAt) / 1000)),
        timeoutCount: streak.count
      };
    }

    let streak = this.streaks.get(key);
    if (!streak) {
      streak = { startedAt: atMs, count: 0, recorded: false };
      this.streaks.set(key, streak);
    }
    streak.count += 1;

    const thresholdMs = Math.max(1, Number(thresholdSeconds) || 3) * 1000;
    if (!streak.recorded && atMs - streak.startedAt >= thresholdMs) {
      streak.recorded = true;
      return {
        type: "record",
        key,
        startedAt: streak.startedAt,
        recordedAt: atMs,
        timeoutCount: streak.count
      };
    }
    return null;
  }

  // Batalkan status "sudah tercatat" (mis. penulisan baris log ke MySQL gagal)
  // agar event "record" boleh terbit lagi pada hasil TIMEOUT berikutnya,
  // tanpa mengulang rangkaian dari awal.
  markUnrecorded(key) {
    const streak = this.streaks.get(key);
    if (streak) streak.recorded = false;
  }

  // Lupakan rangkaian sebuah kunci (mis. perangkat/tujuan dihapus).
  forget(key) {
    this.streaks.delete(key);
  }
}

module.exports = { TimeoutTracker };
