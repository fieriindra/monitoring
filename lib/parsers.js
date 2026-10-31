// Parser output CLI ping multi-vendor (Huawei VRP, Juniper Junos, MikroTik RouterOS).
//
// Prinsip akurasi (semua vendor): keputusan UP/TIMEOUT diambil dari BLOK
// STATISTIK AKHIR ping, BUKAN dari potongan balasan pertama yang ditemukan
// di output. Potongan balasan bisa berasal dari balasan terlambat, sisa output
// perintah sebelumnya di shell interaktif yang sama, atau hasil parsial —
// statistik akhir adalah satu-satunya ringkasan resmi perangkat untuk run itu:
//   Huawei/Juniper: "packet(s) received" + "% packet loss" + "round-trip min/avg/max"
//   MikroTik:       "sent=N received=N packet-loss=N% ... avg-rtt=..."
//   received = 0 atau packet loss 100%  -> TIMEOUT, apa pun potongan balasannya
//   received > 0                         -> UP, latency = rata-rata (avg) statistik

const TIMEOUT_PATTERN = /request time out|timed out|time out|timeout|100(?:\.0+)?%\s*packet loss|packet-loss=100%|0 packets received|no answer|unreachable/i;

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function average(values) {
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function lastMatch(text, pattern) {
  const matches = [...text.matchAll(pattern)];
  return matches.length ? matches[matches.length - 1] : null;
}

// Shell SSH interaktif dipakai bersama antar perintah dan antar target, jadi
// buffer output bisa memuat sisa run ping sebelumnya. Keputusan hanya boleh
// memakai run TERAKHIR, yang ditandai header "PING <host>:" / "PING <host> (".
function lastRunText(text) {
  const headers = [...text.matchAll(/\bPING\s+[A-Za-z0-9.:-]+\s*(?::|\()/gi)];
  if (!headers.length) return text;
  return text.slice(headers[headers.length - 1].index);
}

// Statistik akhir ping Huawei/Juniper dari kemunculan terakhir tiap field.
// Mengembalikan null bila output tidak punya blok statistik (mis. MikroTik).
function pingStatistics(text) {
  const received = lastMatch(text, /(\d+)\s+packets?(?:\(s\))?\s+received/gi);
  const loss = lastMatch(text, /(\d+(?:\.\d+)?)\s*%\s*packet loss/gi);
  if (!received && !loss) return null;
  const rtt = lastMatch(text, /round-trip min\/avg\/max(?:\/[a-z-]+)?\s*=\s*\d+(?:\.\d+)?\/(\d+(?:\.\d+)?)\/\d+(?:\.\d+)?\s*ms/gi);
  return {
    received: received ? Number(received[1]) : null,
    lossPercent: loss ? Number(loss[1]) : null,
    avgLatency: rtt ? round(Number(rtt[1])) : null
  };
}

// Semua latency balasan individual ("Reply from ... time=2 ms" / "time=2.1 ms").
function replyLatencies(text) {
  return [...text.matchAll(/\btime\s*[=<]\s*(\d+(?:\.\d+)?)\s*ms/gi)].map((match) => Number(match[1]));
}

// Nilai RTT MikroTik: "3ms", "3ms381us", atau "944us" -> milidetik.
function rttTokenToMs(token) {
  const text = String(token || "");
  const ms = text.match(/(\d+(?:\.\d+)?)ms/);
  const us = text.match(/(\d+(?:\.\d+)?)us/);
  if (ms) return round(Number(ms[1]) + (us ? Number(us[1]) / 1000 : 0));
  if (us) return round(Number(us[1]) / 1000);
  return null;
}

// Statistik akhir MikroTik dari kemunculan terakhir:
// "sent=3 received=2 packet-loss=33% min-rtt=2ms avg-rtt=3ms max-rtt=4ms".
// Mengembalikan null bila output bukan format MikroTik.
function mikrotikStatistics(text) {
  const summary = lastMatch(text, /sent=(\d+)\s+received=(\d+)\s+packet-loss=(\d+(?:\.\d+)?)%/gi);
  if (!summary) return null;
  const avg = lastMatch(text, /avg-rtt=([0-9a-z.]+)/gi);
  return {
    received: Number(summary[2]),
    lossPercent: Number(summary[3]),
    avgLatency: avg ? rttTokenToMs(avg[1]) : null
  };
}

// Latency tiap baris data MikroTik: "0 8.8.8.8 56 117 3ms381us" / "... 944us".
// Baris timeout ("1 8.8.8.8 timeout") tidak punya nilai waktu dan tidak cocok.
function mikrotikRowLatencies(text) {
  return [...text.matchAll(/^\s*(?:\d+\s+)?\S+\s+\d+\s+\d+\s+((?:\d+(?:\.\d+)?ms(?:\d+us)?)|(?:\d+(?:\.\d+)?us))\b/gim)]
    .map((match) => rttTokenToMs(match[1]))
    .filter((value) => value !== null);
}

// Mengembalikan { status: "UP" | "TIMEOUT", latency: number | null }.
function parsePing(output) {
  const text = lastRunText(String(output || ""));

  // 1) Statistik akhir adalah penentu utama (lihat catatan di atas).
  const stats = pingStatistics(text);
  if (stats) {
    if (stats.received === 0 || (stats.lossPercent !== null && stats.lossPercent >= 100)) {
      return { status: "TIMEOUT", latency: null };
    }
    if (stats.received !== null && stats.received > 0) {
      if (stats.avgLatency !== null) return { status: "UP", latency: stats.avgLatency };
      const latencies = replyLatencies(text);
      if (latencies.length) return { status: "UP", latency: average(latencies) };
      return { status: "UP", latency: null };
    }
  }

  // 1b) Statistik akhir MikroTik adalah penentu untuk format RouterOS.
  //     Kode lama melewatkan statistik ini sepenuhnya: satu baris "timeout"
  //     pada loss parsial membuat seluruh run terbaca TIMEOUT, dan latency
  //     diambil dari baris pertama, bukan avg-rtt ringkasan.
  const mtStats = mikrotikStatistics(text);
  if (mtStats) {
    if (mtStats.received === 0 || mtStats.lossPercent >= 100) {
      return { status: "TIMEOUT", latency: null };
    }
    if (mtStats.avgLatency !== null) return { status: "UP", latency: mtStats.avgLatency };
    const rows = mikrotikRowLatencies(text);
    if (rows.length) return { status: "UP", latency: average(rows) };
    return { status: "UP", latency: null };
  }

  // 2) Tanpa blok statistik lengkap: pakai balasan individual dalam run ini.
  //    Latency adalah rata-rata SEMUA balasan, bukan balasan pertama, dan satu
  //    "Request time out" tidak membatalkan balasan nyata (packet loss parsial
  //    tetap berarti host tercapai). RTO hanya bila tidak ada balasan sama sekali.
  const latencies = replyLatencies(text);
  if (latencies.length) return { status: "UP", latency: average(latencies) };
  if (/request time out/i.test(text)) return { status: "TIMEOUT", latency: null };

  // Baris data MikroTik tanpa ringkasan (output terpotong di tengah run):
  // baris berbalas membuktikan host tercapai walau ada baris timeout lain.
  const rowLatencies = mikrotikRowLatencies(text);
  if (rowLatencies.length) return { status: "UP", latency: average(rowLatencies) };

  // Fallback Huawei/Juniper: "round-trip min/avg/max = 9/9/9 ms" dengan packet loss < 100%
  const rtt = text.match(/round-trip min\/avg\/max\s*=\s*\d+(?:\.\d+)?\/(\d+(?:\.\d+)?)\/\d+(?:\.\d+)?\s*ms/i);
  if (rtt && !/100(?:\.0+)?%\s*packet loss/i.test(text)) {
    return { status: "UP", latency: round(Number(rtt[1])) };
  }

  if (!TIMEOUT_PATTERN.test(text)) {
    // MikroTik: "0 8.8.8.8 56 117 3ms381us" atau "avg-rtt=3ms"
    const mikrotik = text.match(/\b(\d+(?:\.\d+)?)ms(?:(\d+)us)?/i);
    if (mikrotik) {
      return { status: "UP", latency: round(Number(mikrotik[1]) + (mikrotik[2] ? Number(mikrotik[2]) / 1000 : 0)) };
    }
    const micro = text.match(/\b(\d+)us\b/i);
    if (micro) return { status: "UP", latency: round(Number(micro[1]) / 1000) };
  }

  return { status: "TIMEOUT", latency: null };
}

// Satu baris ringkas yang diseragamkan ke format MikroTik:
// - UP:      "0 <IP> <SIZE> <TTL> <TIME>ms"
// - TIMEOUT: "0 <IP> timeout"
function summarize(output, fallbackTarget) {
  const raw = lastRunText(String(output || ""));

  // Statistik akhir menyatakan RTO (0 diterima / loss 100%): tampilkan timeout
  // meskipun buffer masih memuat potongan "Reply from" dari balasan terlambat
  // atau run sebelumnya — potongan itu bukan hasil run ini.
  const stats = pingStatistics(raw);
  if (stats && (stats.received === 0 || (stats.lossPercent !== null && stats.lossPercent >= 100))) {
    const pingHeader = raw.match(/PING\s+([^\s(:]+)/i);
    const host = fallbackTarget || (pingHeader ? pingHeader[1] : "");
    return host ? `0 ${host} timeout` : "0 timeout";
  }

  // Statistik akhir MikroTik menyatakan RTO: tampilkan timeout meskipun masih
  // ada baris data lain di buffer, agar tampilan konsisten dengan status.
  const mtStats = mikrotikStatistics(raw);
  if (mtStats && (mtStats.received === 0 || mtStats.lossPercent >= 100)) {
    return fallbackTarget ? `0 ${fallbackTarget} timeout` : "0 timeout";
  }

  // Format Huawei UP: "Reply from 10.0.0.1: bytes=56 Sequence=1 ttl=254 time=9 ms"
  const huawei = raw.match(/Reply from\s+([^\s:]+):\s*bytes=(\d+)\s+Sequence=\d+\s+ttl=(\d+)\s+time\s*[=<]\s*(\d+(?:\.\d+)?)\s*ms/i);
  if (huawei) {
    return `0 ${huawei[1]} ${huawei[2]} ${huawei[3]} ${huawei[4]}ms`;
  }

  // Format Juniper/Linux UP: "64 bytes from 10.0.0.1: icmp_seq=0 ttl=64 time=2.1 ms"
  const juniper = raw.match(/(\d+)\s+bytes from\s+([^\s:]+):\s*(?:icmp_seq=\d+\s+)?ttl=(\d+)\s+time\s*[=<]\s*(\d+(?:\.\d+)?)\s*ms/i);
  if (juniper) {
    return `0 ${juniper[2]} ${juniper[1]} ${juniper[3]} ${juniper[4]}ms`;
  }

  // Format MikroTik UP: "0 8.8.8.8 56 121 12ms"
  const mikrotikUp = raw.match(/\b0\s+([A-Za-z0-9.:-]+)\s+(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?ms(?:\d+us)?|\d+us)\b/i);
  if (mikrotikUp) {
    return `0 ${mikrotikUp[1]} ${mikrotikUp[2]} ${mikrotikUp[3]} ${mikrotikUp[4]}`;
  }

  // Jika status TIMEOUT (atau output gagal/banner terpotong), seragamkan ke format MikroTik: "0 <IP> timeout"
  const { status } = parsePing(raw);
  if (status === "TIMEOUT") {
    const pingHeader = raw.match(/PING\s+([^\s(:]+)/i) || raw.match(/\b0\s+([A-Za-z0-9.:-]+)\s+timeout\b/i);
    const host = fallbackTarget || (pingHeader ? pingHeader[1] : "");
    return host ? `0 ${host} timeout` : "0 timeout";
  }

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const body = lines.filter((line) => !/^(seq\s+host|ping\s|---|sent=|round-trip|\*+)/i.test(line));
  const reply = body.find((line) => /bytes from|reply from|\btime\s*[=<]|\d+ms|time out|timeout|request|loss|unreachable|error/i.test(line));
  const chosen = reply || body[0] || lines[0] || "(tidak ada output)";
  return chosen.replace(/\s+/g, " ").slice(0, 160);
}

module.exports = { parsePing, summarize };
