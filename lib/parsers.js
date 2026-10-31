// Parser output CLI ping multi-vendor (Huawei VRP, Juniper Junos, MikroTik RouterOS).

const TIMEOUT_PATTERN = /request time out|timed out|time out|timeout|100(?:\.0+)?%\s*packet loss|packet-loss=100%|0 packets received|no answer|unreachable/i;

function round(value) {
  return Math.round(value * 1000) / 1000;
}

// Mengembalikan { status: "UP" | "TIMEOUT", latency: number | null }.
function parsePing(output) {
  const text = String(output || "");

  // Huawei: "Reply from x: bytes=56 Sequence=1 ttl=255 time=2 ms"
  // Juniper: "64 bytes from x: icmp_seq=0 ttl=64 time=2.1 ms"
  const standard = text.match(/\btime\s*[=<]\s*(\d+(?:\.\d+)?)\s*ms/i);
  if (standard) return { status: "UP", latency: round(Number(standard[1])) };

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
  const raw = String(output || "");

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
