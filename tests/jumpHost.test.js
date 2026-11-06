"use strict";

// Tes fitur jump host khusus per perangkat (SSH berantai lewat MikroTik):
// - lib/jumpHost.normalizeJumpConfig memvalidasi baris ping_device_jump_hosts.
// - lib/jumpHost.buildNestedSshCommand membangun perintah RouterOS
//   "/system ssh ..." untuk login bersarang dari shell jump host, dan
//   menolak nilai yang bisa memecah perintah konsol.

const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeJumpConfig, buildNestedSshCommand } = require("../lib/jumpHost");

const ROW = {
  device_id: 24,
  jump_host: "103.163.103.11",
  jump_port: 2222,
  jump_username: "kamal",
  jump_password: "Y2lwaGVydGV4dA=="
};

test("normalizeJumpConfig: baris lengkap dinormalisasi", () => {
  assert.deepEqual(normalizeJumpConfig(ROW), {
    deviceId: 24,
    host: "103.163.103.11",
    port: 2222,
    username: "kamal",
    passwordCipher: "Y2lwaGVydGV4dA=="
  });
});

test("normalizeJumpConfig: null/undefined berarti tanpa jump host", () => {
  assert.equal(normalizeJumpConfig(null), null);
  assert.equal(normalizeJumpConfig(undefined), null);
});

test("normalizeJumpConfig: port kosong memakai default 22", () => {
  assert.equal(normalizeJumpConfig({ ...ROW, jump_port: null }).port, 22);
  assert.equal(normalizeJumpConfig({ ...ROW, jump_port: "" }).port, 22);
});

test("normalizeJumpConfig: nilai rusak ditolak", () => {
  assert.throws(() => normalizeJumpConfig({ ...ROW, device_id: 0 }), TypeError);
  assert.throws(() => normalizeJumpConfig({ ...ROW, jump_host: "" }), TypeError);
  assert.throws(() => normalizeJumpConfig({ ...ROW, jump_host: "10.0.0.1; reboot" }), TypeError);
  assert.throws(() => normalizeJumpConfig({ ...ROW, jump_port: 0 }), TypeError);
  assert.throws(() => normalizeJumpConfig({ ...ROW, jump_port: 70000 }), TypeError);
  assert.throws(() => normalizeJumpConfig({ ...ROW, jump_port: "abc" }), TypeError);
  assert.throws(() => normalizeJumpConfig({ ...ROW, jump_username: "user name" }), TypeError);
  assert.throws(() => normalizeJumpConfig({ ...ROW, jump_password: "" }), TypeError);
});

test("buildNestedSshCommand: port default 22 tidak ditulis", () => {
  const cmd = buildNestedSshCommand({ host: "10.5.6.37", port: 22, username: "mamura" });
  assert.equal(cmd, "/system ssh address=10.5.6.37 user=mamura");
});

test("buildNestedSshCommand: port khusus ditulis", () => {
  const cmd = buildNestedSshCommand({ host: "10.5.6.37", port: 2222, username: "mamura" });
  assert.equal(cmd, "/system ssh address=10.5.6.37 user=mamura port=2222");
});

test("buildNestedSshCommand: upaya memecah perintah konsol ditolak", () => {
  assert.throws(() => buildNestedSshCommand({ host: "10.5.6.37", port: 22, username: "a\rsystem reboot" }), TypeError);
  assert.throws(() => buildNestedSshCommand({ host: "10.5.6.37;quit", port: 22, username: "mamura" }), TypeError);
  assert.throws(() => buildNestedSshCommand({ host: "", port: 22, username: "mamura" }), TypeError);
  assert.throws(() => buildNestedSshCommand({ host: "10.5.6.37", port: 22, username: "" }), TypeError);
});
