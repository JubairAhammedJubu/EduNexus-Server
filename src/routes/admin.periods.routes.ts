import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/session.js";
import { prisma } from "../lib/prisma.js";


export const router = Router();
export const adminOnly = [requireAuth, requireRole("admin")] as const;

// ── Periods (school-wide, set once) ────────────────────────────────────

// GET /api/admin/periods
router.get("/admin/periods", ...adminOnly, async (req, res) => {
  try {
    const periods = await prisma.period.findMany({ orderBy: { periodNumber: "asc" } });
    res.json({ periods });
  } catch (err: any) {
    console.error("[periods] list:", err);
    res.status(500).json({ error: err?.message || "Failed to load periods" });
  }
});

// POST /api/admin/periods/seed-standard
// Default single-shift schedule: 10:00–4:00, 7 periods + one tiffin break
router.post("/admin/periods/seed-standard", ...adminOnly, async (req, res) => {
  try {
    const existing = await prisma.period.count();
    if (existing > 0) {
      return res.status(409).json({ error: "Periods already configured — delete them first to reseed" });
    }

    const schedule = [
      { periodNumber: 1, label: "Period 1", startTime: "10:00", endTime: "10:40", isBreak: false },
      { periodNumber: 2, label: "Period 2", startTime: "10:40", endTime: "11:20", isBreak: false },
      { periodNumber: 3, label: "Period 3", startTime: "11:20", endTime: "12:00", isBreak: false },
      { periodNumber: 4, label: "Period 4", startTime: "12:00", endTime: "12:40", isBreak: false },
      { periodNumber: 5, label: "Tiffin", startTime: "12:40", endTime: "13:10", isBreak: true },
      { periodNumber: 6, label: "Period 5", startTime: "13:10", endTime: "13:50", isBreak: false },
      { periodNumber: 7, label: "Period 6", startTime: "13:50", endTime: "14:30", isBreak: false },
      { periodNumber: 8, label: "Period 7", startTime: "14:30", endTime: "15:10", isBreak: false },
    ];

    await prisma.period.createMany({ data: schedule });
    const periods = await prisma.period.findMany({ orderBy: { periodNumber: "asc" } });
    res.json({ message: "Standard schedule created", periods });
  } catch (err: any) {
    console.error("[periods] seed:", err);
    res.status(500).json({ error: err?.message || "Seed failed" });
  }
});

// POST /api/admin/periods
// Body: { periodNumber, label, startTime, endTime, isBreak? } — for custom schedules
router.post("/admin/periods", ...adminOnly, async (req, res) => {
  try {
    const { periodNumber, label, startTime, endTime, isBreak } = req.body;
    if (!periodNumber || !label || !startTime || !endTime) {
      return res.status(400).json({ error: "periodNumber, label, startTime, endTime are required" });
    }
    const period = await prisma.period.create({
      data: { periodNumber: Number(periodNumber), label, startTime, endTime, isBreak: !!isBreak },
    });
    res.status(201).json({ period });
  } catch (err: any) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "A period with this number already exists" });
    }
    console.error("[periods] create:", err);
    res.status(500).json({ error: err?.message || "Failed to create period" });
  }
});

// DELETE /api/admin/periods/:id
router.delete("/admin/periods/:id", ...adminOnly, async (req, res) => {
  try {
    await prisma.period.delete({ where: { id: req.params.id } });
    res.json({ message: "Period removed" });
  } catch (err: any) {
    console.error("[periods] delete:", err);
    res.status(500).json({ error: err?.message || "Failed to remove period" });
  }
});


export default router;