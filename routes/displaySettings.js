const express = require("express");
const v = require("../lib/validate");

const MODULES = ["ping", "prtg"];
const CAPACITIES = [2, 4, 6, 8, 10, 12, 14, 16];
const DEFAULTS = { slot_capacity: 12, rotate_seconds: 30, manual_resume_seconds: 60 };

// Instalasi lama belum punya kolom manual_resume_seconds: tambahkan sekali saat
// router dibuat (idempoten), supaya cukup deploy + restart tanpa migrasi manual.
async function ensureManualResumeColumn(pool) {
  const [cols] = await pool.execute(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'display_settings' AND COLUMN_NAME = 'manual_resume_seconds'`
  );
  if (Number(cols[0].n) === 0) {
    await pool.execute(
      "ALTER TABLE display_settings ADD COLUMN manual_resume_seconds INT NOT NULL DEFAULT 60"
    );
  }
}

// GET  /api/display-settings/:module        -> { slot_capacity, rotate_seconds, manual_resume_seconds }
// PUT  /api/display-settings/:module  body: { slot_capacity, rotate_seconds, manual_resume_seconds }
function createDisplaySettingsRouter({ pool, requireApiSession }) {
  ensureManualResumeColumn(pool).catch((error) => {
    console.error("Gagal memastikan kolom manual_resume_seconds:", error.code || error.message);
  });

  const router = express.Router();
  router.use(requireApiSession);

  router.get("/:module", async (request, response, next) => {
    try {
      if (!MODULES.includes(request.params.module)) return response.status(404).json({ error: "Modul tidak dikenal." });
      const [rows] = await pool.execute(
        "SELECT slot_capacity, rotate_seconds, manual_resume_seconds FROM display_settings WHERE module = ?",
        [request.params.module]
      );
      return response.json(rows[0] || { ...DEFAULTS });
    } catch (error) {
      return next(error);
    }
  });

  router.put("/:module", async (request, response, next) => {
    try {
      if (!MODULES.includes(request.params.module)) return response.status(404).json({ error: "Modul tidak dikenal." });
      const slotCapacity = v.oneOf(request.body, "slot_capacity", { label: "Kapasitas slot", values: CAPACITIES });
      const rotateSeconds = v.integer(request.body, "rotate_seconds", { label: "Jeda rotasi", min: 5, max: 600 });
      const manualResumeSeconds = v.integer(request.body, "manual_resume_seconds", {
        label: "Jeda kembali otomatis", min: 10, max: 3600, fallback: DEFAULTS.manual_resume_seconds
      });
      await pool.execute(
        `INSERT INTO display_settings (module, slot_capacity, rotate_seconds, manual_resume_seconds) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE slot_capacity = VALUES(slot_capacity), rotate_seconds = VALUES(rotate_seconds), manual_resume_seconds = VALUES(manual_resume_seconds)`,
        [request.params.module, slotCapacity, rotateSeconds, manualResumeSeconds]
      );
      return response.json({ slot_capacity: slotCapacity, rotate_seconds: rotateSeconds, manual_resume_seconds: manualResumeSeconds });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = createDisplaySettingsRouter;
