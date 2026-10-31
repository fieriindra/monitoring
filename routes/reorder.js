const express = require("express");
const v = require("../lib/validate");

const MODULES = {
  ping: { table: "ping_targets", column: "position", hasLabel: true },
  prtg: { table: "prtg_sensors", column: "slot_order", hasLabel: false }
};

// POST /api/reorder/:module  body: [{ id, slot_order, label? }, ...]
// Body harus mencakup SEMUA baris slot modul tersebut dengan slot 1..N yang unik.
function createReorderRouter({ pool, requireApiSession }) {
  const router = express.Router();
  router.use(requireApiSession);

  router.post("/:module", async (request, response, next) => {
    let connection;
    try {
      const config = Object.hasOwn(MODULES, request.params.module) ? MODULES[request.params.module] : null;
      if (!config) return response.status(404).json({ error: "Modul tidak dikenal." });
      const { table, column, hasLabel } = config;

      const items = request.body;
      if (!Array.isArray(items) || items.length === 0 || items.length > v.MAX_SLOTS) {
        throw new v.ValidationError(`Body harus berupa array 1-${v.MAX_SLOTS} item { id, slot_order }.`);
      }
      const ids = new Set();
      const slots = new Set();
      for (const item of items) {
        if (!item || typeof item !== "object") throw new v.ValidationError("Item tidak valid.");
        const id = v.positiveId(item.id);
        const slot = v.integer(item, "slot_order", { label: "slot_order", min: 1, max: v.MAX_SLOTS });
        if (hasLabel && item.label !== undefined && item.label !== null && item.label !== "") {
          v.text(item, "label", { label: "Nama kolom", max: 100 });
        }
        if (ids.has(id) || slots.has(slot)) throw new v.ValidationError("id atau slot_order duplikat.");
        ids.add(id);
        slots.add(slot);
      }

      const [existing] = await pool.query(`SELECT id FROM ${table}`);
      if (existing.length !== ids.size || existing.some((row) => !ids.has(row.id))) {
        throw new v.ValidationError("Daftar item tidak sama dengan data yang tersimpan. Muat ulang halaman lalu coba lagi.");
      }

      connection = await pool.getConnection();
      await connection.beginTransaction();
      for (const item of items) {
        if (hasLabel && item.label !== undefined) {
          const customLabel = typeof item.label === "string" && item.label.trim() ? item.label.trim() : null;
          await connection.execute(`UPDATE ${table} SET ${column} = ?, label = ? WHERE id = ?`, [Number(item.slot_order), customLabel, Number(item.id)]);
        } else {
          await connection.execute(`UPDATE ${table} SET ${column} = ? WHERE id = ?`, [Number(item.slot_order), Number(item.id)]);
        }
      }
      await connection.commit();
      return response.json({ ok: true });
    } catch (error) {
      if (connection) await connection.rollback().catch(() => {});
      return next(error);
    } finally {
      if (connection) connection.release();
    }
  });

  return router;
}

module.exports = createReorderRouter;
