"use strict";

// Tes fitur logical-system per target (khusus Juniper):
// - lib/pingCommand.buildPingCommand menyelipkan "logical-system <nama>"
//   sebelum IP hanya untuk JUNIPER dengan nama yang valid.
// - lib/validate.targetList mem-parse field logical_system dari entri objek
//   maupun segmen "ls=NAMA" dari entri string, dan menolak nama tidak valid.

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildPingCommand } = require("../lib/pingCommand");
const { targetList, ValidationError } = require("../lib/validate");

const JUNIPER = { device_type: "JUNIPER", ping_command: "ping count 3 interval 1 wait 1 <IP>", host: "192.168.1.1" };

test("Juniper dengan logical-system: opsi diselipkan sebelum IP", () => {
  const cmd = buildPingCommand(JUNIPER, { ip: "10.10.10.1", logicalSystem: "LS-CORE" });
  assert.equal(cmd, "ping count 3 interval 1 wait 1 logical-system LS-CORE 10.10.10.1");
});

test("Juniper tanpa logical-system: perintah sama seperti sebelumnya", () => {
  assert.equal(
    buildPingCommand(JUNIPER, { ip: "10.10.10.1", logicalSystem: null }),
    "ping count 3 interval 1 wait 1 10.10.10.1"
  );
  assert.equal(buildPingCommand(JUNIPER, null), "ping count 3 interval 1 wait 1 192.168.1.1");
  assert.equal(buildPingCommand(JUNIPER, { ip: "", logicalSystem: null }), "ping count 3 interval 1 wait 1 192.168.1.1");
});

test("Juniper dengan nama logical-system tidak valid: diabaikan, tidak disisipkan", () => {
  const cmd = buildPingCommand(JUNIPER, { ip: "10.10.10.1", logicalSystem: "LS; reboot" });
  assert.equal(cmd, "ping count 3 interval 1 wait 1 10.10.10.1");
});

test("Vendor lain tidak terpengaruh logical-system; MikroTik src-address tetap bekerja", () => {
  const mikrotik = { device_type: "MIKROTIK", ping_command: "/ping count=3 interval=1s <IP>", host: "192.168.1.1", src_address: "103.163.103.255" };
  assert.equal(
    buildPingCommand(mikrotik, { ip: "10.0.0.1", logicalSystem: "LS-CORE" }),
    "/ping src-address=103.163.103.255 count=3 interval=1s 10.0.0.1"
  );
  const huawei = { device_type: "HUAWEI", ping_command: "ping -c 3 -m 200 -t 1000 <IP>", host: "192.168.1.1" };
  assert.equal(
    buildPingCommand(huawei, { ip: "10.0.0.1", logicalSystem: "LS-CORE" }),
    "ping -c 3 -m 200 -t 1000 10.0.0.1"
  );
});

test("targetList: entri objek dengan logical_system terbaca", () => {
  const result = targetList({ targets: [{ target: "10.10.10.1", label: "Core", logical_system: "LS-CORE" }] }, "targets", { label: "Target" });
  assert.deepEqual(result, [{ target: "10.10.10.1", label: "Core", logical_system: "LS-CORE" }]);
});

test("targetList: entri objek tanpa field logical_system menghasilkan undefined (boleh mempertahankan nilai lama)", () => {
  const result = targetList({ targets: [{ target: "10.10.10.1", label: null }] }, "targets", { label: "Target" });
  assert.equal(result.length, 1);
  assert.equal(result[0].logical_system, undefined);
});

test("targetList: entri objek dengan logical_system kosong menghasilkan null", () => {
  const result = targetList({ targets: [{ target: "10.10.10.1", logical_system: "" }] }, "targets", { label: "Target" });
  assert.equal(result[0].logical_system, null);
});

test("targetList: segmen ls= pada entri string terbaca, dengan atau tanpa label", () => {
  const withLabel = targetList({ targets: ["10.10.10.1 | Core | ls=LS-CORE"] }, "targets", { label: "Target" });
  assert.deepEqual(withLabel, [{ target: "10.10.10.1", label: "Core", logical_system: "LS-CORE" }]);
  const noLabel = targetList({ targets: ["10.10.10.1 | ls=LS-CORE"] }, "targets", { label: "Target" });
  assert.deepEqual(noLabel, [{ target: "10.10.10.1", label: null, logical_system: "LS-CORE" }]);
  const plain = targetList({ targets: ["10.10.10.1"] }, "targets", { label: "Target" });
  assert.deepEqual(plain, [{ target: "10.10.10.1", label: null, logical_system: null }]);
});

test("targetList: nama logical-system tidak valid ditolak", () => {
  assert.throws(
    () => targetList({ targets: [{ target: "10.10.10.1", logical_system: "LS JELEK" }] }, "targets", { label: "Target" }),
    ValidationError
  );
  assert.throws(
    () => targetList({ targets: ["10.10.10.1 | ls=LS;reboot"] }, "targets", { label: "Target" }),
    ValidationError
  );
});
