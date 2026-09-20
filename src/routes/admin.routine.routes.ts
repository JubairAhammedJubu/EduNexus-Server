import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/session.js";
import { prisma } from "../lib/prisma.js";

export const router = Router();
export const adminOnly = [requireAuth, requireRole("admin")] as const;

// ── Routine grid for a section ──────────────────────────────────────────

// GET /api/admin/routine/sections/:sectionId
router.get("/admin/routine/sections/:sectionId", ...adminOnly, async (req, res) => {
  try {
    const section = await prisma.classSection.findUnique({
      where: { id: req.params.sectionId },
      include: { schoolClass: true },
    });
    if (!section) {
      return res.status(404).json({ error: "Section not found" });
    }

    const [periods, slots, classSubjects] = await Promise.all([
      prisma.period.findMany({ orderBy: { periodNumber: "asc" } }),
      prisma.routineSlot.findMany({
        where: { sectionId: section.id },
        include: { classSubject: { include: { subject: true } } },
      }),
      prisma.classSubject.findMany({
        where: { sectionId: section.id },
        include: { subject: true },
      }),
    ]);

    const teacherIds = [...new Set(classSubjects.map((cs) => cs.teacherId).filter(Boolean))] as string[];
    const teachers = teacherIds.length
      ? await prisma.user.findMany({ where: { id: { in: teacherIds } }, select: { id: true, name: true } })
      : [];
    const teacherMap = Object.fromEntries(teachers.map((t) => [t.id, t.name]));

    const grid: Record<string, Record<string, any>> = {};
    for (const day of ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY"]) {
      grid[day] = {};
    }
    for (const slot of slots) {
      grid[slot.day][slot.periodId] = {
        id: slot.id,
        classSubjectId: slot.classSubjectId,
        subject: slot.classSubject.subject.name,
        teacherName: slot.classSubject.teacherId ? teacherMap[slot.classSubject.teacherId] ?? "Unassigned" : "Unassigned",
        room: slot.room,
      };
    }

    res.json({
      section: { id: section.id, name: section.name },
      class: { id: section.schoolClass.id, name: section.schoolClass.name },
      periods,
      grid,
      availableSubjects: classSubjects.map((cs) => ({
        classSubjectId: cs.id,
        name: cs.subject.name,
        teacherName: cs.teacherId ? teacherMap[cs.teacherId] ?? "Unassigned" : "Unassigned",
      })),
    });
  } catch (err: any) {
    console.error("[routine] load:", err);
    res.status(500).json({ error: err?.message || "Failed to load routine" });
  }
});

// PUT /api/admin/routine/sections/:sectionId/slot
// Body: { day, periodId, classSubjectId, room? } — upserts one cell
router.put("/admin/routine/sections/:sectionId/slot", ...adminOnly, async (req, res) => {
  try {
    const { sectionId } = req.params;
    const { day, periodId, classSubjectId, room } = req.body;

    if (!day || !periodId || !classSubjectId) {
      return res.status(400).json({ error: "day, periodId, and classSubjectId are required" });
    }

    const period = await prisma.period.findUnique({ where: { id: periodId } });
    if (period?.isBreak) {
      return res.status(400).json({ error: "Can't schedule a subject during a break period" });
    }

    const classSubject = await prisma.classSubject.findUnique({ where: { id: classSubjectId } });
    if (!classSubject || classSubject.sectionId !== sectionId) {
      return res.status(400).json({ error: "This subject isn't assigned to this section" });
    }

    // Teacher double-booking check — same teacher, same day, same period, different section
    if (classSubject.teacherId) {
      const conflict = await prisma.routineSlot.findFirst({
        where: {
          day,
          periodId,
          sectionId: { not: sectionId },
          classSubject: { teacherId: classSubject.teacherId },
        },
        include: { section: true, classSubject: { include: { subject: true } } },
      });
      if (conflict) {
        return res.status(409).json({
          error: `Teacher conflict: already teaching ${conflict.classSubject.subject.name} in ${conflict.section.name} at this time`,
        });
      }
    }

    const slot = await prisma.routineSlot.upsert({
      where: { sectionId_day_periodId: { sectionId, day, periodId } },
      update: { classSubjectId, room },
      create: { sectionId, day, periodId, classSubjectId, room },
    });

    res.json({ slot });
  } catch (err: any) {
    console.error("[routine] set slot:", err);
    res.status(500).json({ error: err?.message || "Failed to update routine" });
  }
});

// DELETE /api/admin/routine/slots/:slotId
router.delete("/admin/routine/slots/:slotId", ...adminOnly, async (req, res) => {
  try {
    await prisma.routineSlot.delete({ where: { id: req.params.slotId } });
    res.json({ message: "Slot cleared" });
  } catch (err: any) {
    console.error("[routine] delete slot:", err);
    res.status(500).json({ error: err?.message || "Failed to clear slot" });
  }
});

// ── A teacher's personal timetable across all sections ──────────────────

// GET /api/admin/routine/teachers/:teacherId
router.get("/admin/routine/teachers/:teacherId", ...adminOnly, async (req, res) => {
  try {
    const slots = await prisma.routineSlot.findMany({
      where: { classSubject: { teacherId: req.params.teacherId } },
      include: {
        period: true,
        section: { include: { schoolClass: true } },
        classSubject: { include: { subject: true } },
      },
      orderBy: [{ day: "asc" }, { period: { periodNumber: "asc" } }],
    });

    res.json({
      timetable: slots.map((s) => ({
        day: s.day,
        period: s.period.label,
        startTime: s.period.startTime,
        endTime: s.period.endTime,
        class: `${s.section.schoolClass.name} - ${s.section.name}`,
        subject: s.classSubject.subject.name,
      })),
    });
  } catch (err: any) {
    console.error("[routine] teacher timetable:", err);
    res.status(500).json({ error: err?.message || "Failed to load timetable" });
  }
});

export default router;