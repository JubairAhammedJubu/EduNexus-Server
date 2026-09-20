import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/session.js";
import { prisma } from "../lib/prisma.js";

export const router = Router();
export const adminOnly = [requireAuth, requireRole("admin")] as const;

// ── Periods (school-wide, set once) ────────────────────────────────────

// GET /api/admin/periods
router.get("/admin/periods", ...adminOnly, async (req, res) => {
  try {
    const periods = await prisma.period.findMany({
      orderBy: { periodNumber: "asc" },
    });
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
      return res
        .status(409)
        .json({
          error: "Periods already configured — delete them first to reseed",
        });
    }

    const schedule = [
      {
        periodNumber: 1,
        label: "Period 1",
        startTime: "10:00",
        endTime: "10:40",
        isBreak: false,
      },
      {
        periodNumber: 2,
        label: "Period 2",
        startTime: "10:40",
        endTime: "11:20",
        isBreak: false,
      },
      {
        periodNumber: 3,
        label: "Period 3",
        startTime: "11:20",
        endTime: "12:00",
        isBreak: false,
      },
      {
        periodNumber: 4,
        label: "Period 4",
        startTime: "12:00",
        endTime: "12:40",
        isBreak: false,
      },
      {
        periodNumber: 5,
        label: "Tiffin",
        startTime: "12:40",
        endTime: "13:10",
        isBreak: true,
      },
      {
        periodNumber: 6,
        label: "Period 5",
        startTime: "13:10",
        endTime: "13:50",
        isBreak: false,
      },
      {
        periodNumber: 7,
        label: "Period 6",
        startTime: "13:50",
        endTime: "14:30",
        isBreak: false,
      },
      {
        periodNumber: 8,
        label: "Period 7",
        startTime: "14:30",
        endTime: "15:10",
        isBreak: false,
      },
    ];

    await prisma.period.createMany({ data: schedule });
    const periods = await prisma.period.findMany({
      orderBy: { periodNumber: "asc" },
    });
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
      return res
        .status(400)
        .json({
          error: "periodNumber, label, startTime, endTime are required",
        });
    }
    const period = await prisma.period.create({
      data: {
        periodNumber: Number(periodNumber),
        label,
        startTime,
        endTime,
        isBreak: !!isBreak,
      },
    });
    res.status(201).json({ period });
  } catch (err: any) {
    if (err.code === "P2002") {
      return res
        .status(409)
        .json({ error: "A period with this number already exists" });
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

// GET /api/student/routine — student's own section's weekly routine
router.get(
  "/student/routine",
  requireAuth,
  requireRole("student"),
  async (req, res) => {
    try {
      const studentClass = req.user!.studentClass ?? "";
      const studentSection = req.user!.studentSection ?? "";

      const section = await prisma.classSection.findFirst({
        where: { name: studentSection, schoolClass: { name: studentClass } },
      });

      if (!section) {
        return res
          .status(404)
          .json({ error: "Your section could not be found" });
      }

      const [periods, slots] = await Promise.all([
        prisma.period.findMany({ orderBy: { periodNumber: "asc" } }),
        prisma.routineSlot.findMany({
          where: { sectionId: section.id },
          include: {
            classSubject: { include: { subject: true } },
          },
        }),
      ]);

      const teacherIds = [
        ...new Set(slots.map((s) => s.classSubject.teacherId).filter(Boolean)),
      ] as string[];
      const teachers = teacherIds.length
        ? await prisma.user.findMany({
            where: { id: { in: teacherIds } },
            select: { id: true, name: true },
          })
        : [];
      const teacherMap = Object.fromEntries(
        teachers.map((t) => [t.id, t.name]),
      );

      const grid: Record<string, Record<string, any>> = {};
      for (const day of [
        "SUNDAY",
        "MONDAY",
        "TUESDAY",
        "WEDNESDAY",
        "THURSDAY",
      ]) {
        grid[day] = {};
      }
      for (const s of slots) {
        grid[s.day][s.periodId] = {
          subject: s.classSubject.subject.name,
          teacherName: s.classSubject.teacherId
            ? (teacherMap[s.classSubject.teacherId] ?? "TBA")
            : "TBA",
          room: s.room,
        };
      }

      res.json({
        section: `${studentClass} - ${studentSection}`,
        periods,
        grid,
      });
    } catch (err: any) {
      console.error("[routine] student self:", err);
      res
        .status(500)
        .json({ error: err?.message || "Failed to load your routine" });
    }
  },
);

/**
 * GET /api/teacher/routine
 * Weekly slots where this teacher is subject teacher (or substitute).
 */
router.get(
  "/teacher/routine",
  requireAuth,
  requireRole("teacher"),
  async (req, res) => {
    try {
      const teacherId = req.user!.id;

      // Subjects this teacher teaches (primary or substitute)
      const classSubjects = await prisma.classSubject.findMany({
        where: {
          OR: [{ teacherId }, { substituteTeacherId: teacherId }],
        },
        select: { id: true },
      });

      const classSubjectIds = classSubjects.map((cs) => cs.id);

      if (classSubjectIds.length === 0) {
        return res.json({
          success: true,
          periods: await prisma.period.findMany({
            orderBy: { periodNumber: "asc" },
          }),
          grid: emptyGrid(),
          slots: [],
          message: "No subject assignments yet",
        });
      }

      const [periods, slots] = await Promise.all([
        prisma.period.findMany({ orderBy: { periodNumber: "asc" } }),
        prisma.routineSlot.findMany({
          where: { classSubjectId: { in: classSubjectIds } },
          include: {
            classSubject: {
              include: {
                subject: true,
                // section + class — adjust names to your schema
              },
            },
          },
        }),
      ]);

      // Load sections for class/section labels
      const sectionIds = [
        ...new Set(
          slots
            .map((s: any) => s.sectionId || s.classSubject?.sectionId)
            .filter(Boolean),
        ),
      ] as string[];

      const sections = sectionIds.length
        ? await prisma.classSection.findMany({
            where: { id: { in: sectionIds } },
            include: {
              schoolClass: { select: { name: true } },
            },
          })
        : [];
      const sectionMap = Object.fromEntries(
        sections.map((s) => [
          s.id,
          {
            sectionName: s.name,
            className: s.schoolClass.name,
          },
        ]),
      );

      const grid = emptyGrid();

      const flatSlots = slots.map((s: any) => {
        const sectionId = s.sectionId || s.classSubject?.sectionId;
        const sec = sectionId ? sectionMap[sectionId] : null;
        const isSubstitute =
          s.classSubject?.substituteTeacherId === teacherId &&
          s.classSubject?.teacherId !== teacherId;

        const cell = {
          subject: s.classSubject?.subject?.name ?? "—",
          className: sec?.className ?? "—",
          sectionName: sec?.sectionName ?? "—",
          room: s.room ?? null,
          role: isSubstitute ? "SUBSTITUTE" : "PRIMARY",
        };

        if (grid[s.day]) {
          grid[s.day][s.periodId] = cell;
        }

        return {
          id: s.id,
          day: s.day,
          periodId: s.periodId,
          ...cell,
        };
      });

      return res.json({
        success: true,
        periods,
        grid,
        slots: flatSlots,
      });
    } catch (err: any) {
      console.error("[routine] teacher self:", err);
      return res.status(500).json({
        error: err?.message || "Failed to load teacher routine",
      });
    }
  },
);

function emptyGrid() {
  const grid: Record<string, Record<string, any>> = {};
  for (const day of ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY"]) {
    grid[day] = {};
  }
  return grid;
}
export default router;
