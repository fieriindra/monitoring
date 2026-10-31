const express = require("express");
const v = require("../lib/validate");

const MODULES = ["ping", "prtg"];
const CAPACITIES = [2, 4, 6, 8, 10, 12, 14, 16];

// GET  /api/display-settings/:module        -> { slot_capacity, rotate_seconds }
// PUT  /api/display-settings/:module  body: { slot_capacity, rotate_seconds }
function createDisplaySettingsRouter({ pool, requireApiSession }) {
  const router = express.Router();
  router.use(requireApiSession);

  router.get("/:module", async (request, response, next) => {
    try {
      if (!MODULES.includes(request.params.module)) return response.status(404).json({ error: "Modul tidak dikenal." });
      const [rows] = await pool.execute(
        "SELECT slot_capacity, rotate_seconds FROM display_settings WHERE module = ?",
        [request.params.module]
      );
      return response.json(rows[0] || { slot_capacity: 12, rotate_seconds: 30 });
    } catch (error) {
      return next(error);
    }
  });

  router.put("/:module", async (request, response, next) => {
    try {
      if (!MODULES.includes(request.params.module)) return response.status(404).json({ error: "Modul tidak dikenal." });
      const slotCapacity = v.oneOf(request.body, "slot_capacity", { label: "Kapasitas slot", values: CAPACITIES });
      const rotateSeconds = v.integer(request.body, "rotate_seconds", { label: "Jeda rotasi", min: 5, max: 600 });
      await pool.execute(
        `INSERT INTO display_settings (module, slot_capacity, rotate_seconds) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE slot_capacity = VALUES(slot_capacity), rotate_seconds = VALUES(rotate_seconds)`,
        [request.params.module, slotCapacity, rotateSeconds]
      );
      return response.json({ slot_capacity: slotCapacity, rotate_seconds: rotateSeconds });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = createDisplaySettingsRouter;
