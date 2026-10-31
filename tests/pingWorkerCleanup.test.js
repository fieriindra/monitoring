"use strict";

// Tes pembersihan retensi worker memakai pool palsu: cleanup() harus
// menghapus ping_logs (berdasarkan created_at) DAN ping_timeout_logs
// (berdasarkan started_at) dengan parameter masa retensi yang sama,
// per batch, sampai batch terakhir tidak penuh lagi.
const test = require("node:test");
const assert = require("node:assert/strict");

const worker = require("../workers/pingWorker");
const BATCH = 10000; // CLEANUP_BATCH di workers/pingWorker.js

function fakePool(affectedSequence, failOnCall = -1) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (calls.length === failOnCall) {
        const error = new Error("tabel tidak ada");
        error.code = "ER_NO_SUCH_TABLE";
        throw error;
      }
      const affectedRows = affectedSequence[Math.min(index, affectedSequence.length - 1)];
      index += 1;
      return [{ affectedRows }];
    }
  };
}

test("cleanup menghapus ping_logs dan ping_timeout_logs per batch dengan retensi yang sama", async () => {
  // ping_logs: batch penuh (lanjut) lalu sebagian (berhenti); timeout: sebagian.
  const pool = fakePool([BATCH, 3, 2]);
  worker.pool = pool;
  await worker.cleanup(7);

  assert.equal(pool.calls.length, 3);
  assert.match(pool.calls[0].sql, /DELETE FROM ping_logs WHERE created_at < NOW\(\) - INTERVAL \? DAY LIMIT \?/);
  assert.deepEqual(pool.calls[0].params, [7, BATCH]);
  assert.match(pool.calls[1].sql, /DELETE FROM ping_logs/);
  assert.match(pool.calls[2].sql, /DELETE FROM ping_timeout_logs WHERE started_at < NOW\(\) - INTERVAL \? DAY LIMIT \?/);
  assert.deepEqual(pool.calls[2].params, [7, BATCH]);
});

test("cleanup mengabaikan tabel ping_timeout_logs yang belum ada", async () => {
  const pool = fakePool([0], 2); // panggilan kedua (timeout logs) gagal ER_NO_SUCH_TABLE
  worker.pool = pool;
  await worker.cleanup(7); // tidak boleh melempar
  assert.equal(pool.calls.length, 2);
});
