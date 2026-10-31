// Tes parser ping: keputusan UP/TIMEOUT harus mengikuti statistik akhir
// perangkat (kasus Huawei RTO), bukan potongan balasan pertama di output.
const test = require("node:test");
const assert = require("node:assert/strict");
const { parsePing, summarize } = require("../lib/parsers");

const HUAWEI_UP = `
  PING 10.0.0.1: 56  data bytes, press CTRL_C to break
    Reply from 10.0.0.1: bytes=56 Sequence=1 ttl=255 time=2 ms

  --- 10.0.0.1 ping statistics ---
    1 packet(s) transmitted
    1 packet(s) received
    0.00% packet loss
    round-trip min/avg/max = 2/2/2 ms
<HUAWEI>`;

const HUAWEI_RTO = `
  PING 10.0.0.2: 56  data bytes, press CTRL_C to break
    Request time out

  --- 10.0.0.2 ping statistics ---
    1 packet(s) transmitted
    0 packet(s) received
    100.00% packet loss
    round-trip min/avg/max = 0/0/0 ms
<HUAWEI>`;

// Sisa run SEBELUMNYA (UP) masih ada di buffer shell yang sama, run terakhir RTO.
const BUFFER_TWO_RUNS = `
  PING 10.0.0.1: 56  data bytes, press CTRL_C to break
    Reply from 10.0.0.1: bytes=56 Sequence=1 ttl=255 time=3 ms
  --- 10.0.0.1 ping statistics ---
    1 packet(s) transmitted
    1 packet(s) received
    0.00% packet loss
    round-trip min/avg/max = 3/3/3 ms
<HUAWEI>
  PING 10.0.0.2: 56  data bytes, press CTRL_C to break
    Request time out
  --- 10.0.0.2 ping statistics ---
    1 packet(s) transmitted
    0 packet(s) received
    100.00% packet loss
<HUAWEI>`;

// Balasan datang terlambat SETELAH "Request time out" (kasus yang didokumentasikan
// Huawei): perangkat menghitung 0 paket diterima, jadi run ini tetap RTO.
const HUAWEI_LATE_REPLY_RTO = `
  PING 10.0.0.9: 56  data bytes, press CTRL_C to break
    Request time out
    Reply from 10.0.0.9: bytes=56 Sequence=1 ttl=255 time=150 ms
  --- 10.0.0.9 ping statistics ---
    1 packet(s) transmitted
    0 packet(s) received
    100.00% packet loss
<HUAWEI>`;

const HUAWEI_PARTIAL = `
  PING 10.0.0.3: 56  data bytes, press CTRL_C to break
    Reply from 10.0.0.3: bytes=56 Sequence=1 ttl=255 time=10 ms
    Request time out
    Reply from 10.0.0.3: bytes=56 Sequence=3 ttl=255 time=30 ms
  --- 10.0.0.3 ping statistics ---
    3 packet(s) transmitted
    2 packet(s) received
    33.33% packet loss
    round-trip min/avg/max = 10/20/30 ms
<HUAWEI>`;

test("Huawei UP normal: UP dengan latency dari statistik", () => {
  assert.deepEqual(parsePing(HUAWEI_UP), { status: "UP", latency: 2 });
  assert.equal(summarize(HUAWEI_UP, "10.0.0.1"), "0 10.0.0.1 56 255 2ms");
});

test("Huawei RTO: statistik 0 diterima / loss 100% -> TIMEOUT walau ada round-trip 0/0/0", () => {
  assert.deepEqual(parsePing(HUAWEI_RTO), { status: "TIMEOUT", latency: null });
  assert.equal(summarize(HUAWEI_RTO, "10.0.0.2"), "0 10.0.0.2 timeout");
});

test("RTO tidak tertukar sisa balasan run sebelumnya di shell yang sama", () => {
  assert.deepEqual(parsePing(BUFFER_TWO_RUNS), { status: "TIMEOUT", latency: null });
  assert.equal(summarize(BUFFER_TWO_RUNS, "10.0.0.2"), "0 10.0.0.2 timeout");
});

test("Balasan terlambat setelah Request time out tetap RTO bila statistik 0 diterima", () => {
  assert.deepEqual(parsePing(HUAWEI_LATE_REPLY_RTO), { status: "TIMEOUT", latency: null });
  assert.equal(summarize(HUAWEI_LATE_REPLY_RTO, "10.0.0.9"), "0 10.0.0.9 timeout");
});

test("Packet loss parsial tetap UP, latency memakai rata-rata statistik (bukan balasan pertama)", () => {
  assert.deepEqual(parsePing(HUAWEI_PARTIAL), { status: "UP", latency: 20 });
});

test("Output terpotong sebelum statistik: Request time out saja sudah TIMEOUT", () => {
  const partial = "  PING 10.0.0.2: 56  data bytes, press CTRL_C to break\n    Request time out\n";
  assert.deepEqual(parsePing(partial), { status: "TIMEOUT", latency: null });
});

test("Juniper tetap terbaca, latency dari rata-rata statistik", () => {
  const juniper = `
PING 10.0.0.5 (10.0.0.5): 56 data bytes
64 bytes from 10.0.0.5: icmp_seq=0 ttl=64 time=1.5 ms
64 bytes from 10.0.0.5: icmp_seq=1 ttl=64 time=2.5 ms
--- 10.0.0.5 ping statistics ---
2 packets transmitted, 2 packets received, 0% packet loss
round-trip min/avg/max/stddev = 1.5/2.0/2.5/0.5 ms`;
  assert.deepEqual(parsePing(juniper), { status: "UP", latency: 2 });
});

test("MikroTik UP dan timeout tidak berubah", () => {
  assert.deepEqual(parsePing("0 8.8.8.8 56 117 3ms381us"), { status: "UP", latency: 3.381 });
  assert.deepEqual(parsePing("0 8.8.8.8 timeout"), { status: "TIMEOUT", latency: null });
});

const MT_PARTIAL = `  SEQ HOST                                     SIZE TTL TIME       STATUS
    0 8.8.8.8                                  56  117 2ms
    1 8.8.8.8                                                       timeout
    2 8.8.8.8                                  56  117 4ms
    sent=3 received=2 packet-loss=33% min-rtt=2ms avg-rtt=3ms max-rtt=4ms`;

const MT_RTO = `  SEQ HOST                                     SIZE TTL TIME       STATUS
    0 8.8.8.8                                                       timeout
    1 8.8.8.8                                                       timeout
    2 8.8.8.8                                                       timeout
    sent=3 received=0 packet-loss=100% min-rtt=0ms avg-rtt=0ms max-rtt=0ms`;

test("MikroTik loss parsial tetap UP, latency dari avg-rtt ringkasan (bukan baris pertama / bukan TIMEOUT)", () => {
  assert.deepEqual(parsePing(MT_PARTIAL), { status: "UP", latency: 3 });
  assert.equal(summarize(MT_PARTIAL, "8.8.8.8"), "0 8.8.8.8 56 117 2ms");
});

test("MikroTik RTO penuh: received=0 / packet-loss=100% -> TIMEOUT dan tampilan konsisten", () => {
  assert.deepEqual(parsePing(MT_RTO), { status: "TIMEOUT", latency: null });
  assert.equal(summarize(MT_RTO, "8.8.8.8"), "0 8.8.8.8 timeout");
});

test("MikroTik latency memakai avg-rtt, bukan waktu baris pertama", () => {
  const output = "0 8.8.8.8 56 117 10ms\n1 8.8.8.8 56 117 2ms\nsent=2 received=2 packet-loss=0% min-rtt=2ms avg-rtt=6ms max-rtt=10ms";
  assert.deepEqual(parsePing(output), { status: "UP", latency: 6 });
});

test("MikroTik RTT di bawah 1 ms (satuan us) terbaca dari avg-rtt", () => {
  const output = "0 192.168.192.252 56 64 407us\n1 192.168.192.252 56 64 452us\nsent=2 received=2 packet-loss=0% min-rtt=407us avg-rtt=436us max-rtt=452us";
  assert.deepEqual(parsePing(output), { status: "UP", latency: 0.436 });
});

test("MikroTik output terpotong tanpa ringkasan: baris berbalas tetap UP walau ada baris timeout", () => {
  const output = "0 8.8.8.8 56 117 5ms\n1 8.8.8.8 timeout";
  assert.deepEqual(parsePing(output), { status: "UP", latency: 5 });
});

test("Juniper loss parsial: statistik received>0 -> UP dengan rata-rata round-trip", () => {
  const juniper = `
PING 10.0.0.5 (10.0.0.5): 56 data bytes
64 bytes from 10.0.0.5: icmp_seq=0 ttl=64 time=1.5 ms
64 bytes from 10.0.0.5: icmp_seq=2 ttl=64 time=2.5 ms
--- 10.0.0.5 ping statistics ---
3 packets transmitted, 2 packets received, 33% packet loss
round-trip min/avg/max/stddev = 1.5/2.0/2.5/0.5 ms`;
  assert.deepEqual(parsePing(juniper), { status: "UP", latency: 2 });
});

test("Juniper RTO penuh tanpa baris round-trip -> TIMEOUT", () => {
  const juniper = `
PING 10.0.0.5 (10.0.0.5): 56 data bytes
--- 10.0.0.5 ping statistics ---
3 packets transmitted, 0 packets received, 100% packet loss`;
  assert.deepEqual(parsePing(juniper), { status: "TIMEOUT", latency: null });
  assert.equal(summarize(juniper, "10.0.0.5"), "0 10.0.0.5 timeout");
});
