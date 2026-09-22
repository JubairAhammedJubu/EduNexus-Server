import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/session.js";
import { prisma } from "../lib/prisma.js";

export const router = Router();
export const adminOnly = [requireAuth, requireRole("admin")] as const;

// ── Routine grid for a section ──────────────────────────────────────────
const DEFAULT_GROUPS_9_10 = [
  "Science",
  "Business Studies",
  "Humanities",
] as const;

function getAllowedGroups(schoolClass: {
  hasGroups?: boolean | null;
  groupNames?: string[] | null;
}): string[] {
  if (!schoolClass.hasGroups) return [];
  const custom = schoolClass.groupNames?.filter(Boolean) ?? [];
  return custom.length ? custom : [...DEFAULT_GROUPS_9_10];
}

function normalizeGroup(
  raw: unknown,
  hasGroups: boolean,
  allowed: string[],
): string | null {
  if (!hasGroups) return null;
  const g = String(raw || "").trim();
  if (!g) return null;
  if (!allowed.includes(g)) {
    throw new Error(
      `Invalid group. Allowed: ${allowed.join(" | ")}`,
    );
  }
  return g;
}

// GET /api/admin/routine/sections/:sectionId?group=Science
router.get(
  "/admin/routine/sections/:sectionId",
  ...adminOnly,
  async (req, res) => {
    try {
      const section = await prisma.classSection.findUnique({
        where: { id: req.params.sectionId },
        include: { schoolClass: true },
      });
      if (!section) {
        return res.status(404).json({ error: "Section not found" });
      }

      const hasGroups = Boolean(section.schoolClass.hasGroups);
      const allowed = getAllowedGroups(section.schoolClass as any);

      let group: string | null = null;
      try {
        group = normalizeGroup(req.query.group, hasGroups, allowed);
      } catch (e: any) {
        return res.status(400).json({ error: e.message });
      }

      if (hasGroups && !group) {
        return res.status(400).json({
          error: "Query ?group= is required for Class 9–10",
          groups: allowed,
        });
      }

      const [periods, slots, classSubjects] = await Promise.all([
        prisma.period.findMany({ orderBy: { periodNumber: "asc" } }),
        prisma.routineSlot.findMany({
          where: {
            sectionId: section.id,
            ...(hasGroups && group ? { group } : {}),
          },
          include: {
            classSubject: { include: { subject: true } },
          },
        }),
        prisma.classSubject.findMany({
          where: { sectionId: section.id },
          include: {
            subject: { include: { group: true } },
          },
        }),
      ]);

      const teacherIds = [
        ...new Set(
          classSubjects
            .map((cs) => cs.teacherId)
            .filter(Boolean) as string[],
        ),
      ];
      const teachers = teacherIds.length
        ? await prisma.user.findMany({
            where: { id: { in: teacherIds } },
            select: { id: true, name: true },
          })
        : [];
      const tMap = Object.fromEntries(teachers.map((t) => [t.id, t.name]));

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

      for (const s of slots as any[]) {
        grid[s.day][s.periodId] = {
          id: s.id,
          classSubjectId: s.classSubjectId,
          subject: s.classSubject?.subject?.name,
          teacherName: s.classSubject?.teacherId
            ? (tMap[s.classSubject.teacherId] ?? "TBA")
            : "TBA",
          room: s.room,
        };
      }

      const availableSubjects = classSubjects
        .filter((cs: any) => {
          if (!hasGroups || !group) return true;
          const gName = cs.subject?.group?.name;
          if (!gName) return true; // core
          return gName === group;
        })
        .map((cs: any) => ({
          classSubjectId: cs.id,
          name: cs.subject.name,
          teacherName: cs.teacherId
            ? (tMap[cs.teacherId] ?? "Unassigned")
            : "Unassigned",
        }));

      res.json({
        section: {
          id: section.id,
          name: section.name,
          group,
        },
        class: {
          id: section.schoolClass.id,
          name: section.schoolClass.name,
          hasGroups,
          groups: allowed,
        },
        periods,
        grid,
        availableSubjects,
      });
    } catch (err: any) {
      console.error("[routine] get section:", err);
      res
        .status(500)
        .json({ error: err?.message || "Failed to load routine" });
    }
  },
);

// PUT /api/admin/routine/sections/:sectionId/slot
// Body: { day, periodId, classSubjectId, group?, room? }
router.put(
  "/admin/routine/sections/:sectionId/slot",
  ...adminOnly,
  async (req, res) => {
    try {
      const { day, periodId, classSubjectId, room } = req.body;

      if (!day || !periodId || !classSubjectId) {
        return res
          .status(400)
          .json({ error: "day, periodId, classSubjectId required" });
      }

      const section = await prisma.classSection.findUnique({
        where: { id: req.params.sectionId },
        include: { schoolClass: true },
      });
      if (!section) {
        return res.status(404).json({ error: "Section not found" });
      }

      const hasGroups = Boolean(section.schoolClass.hasGroups);
      const allowed = getAllowedGroups(section.schoolClass as any);

      let group: string | null = null;
      try {
        group = normalizeGroup(req.body.group, hasGroups, allowed);
      } catch (e: any) {
        return res.status(400).json({ error: e.message });
      }
      if (hasGroups && !group) {
        return res.status(400).json({ error: "group is required" });
      }

      // Manual upsert — works on Mongo without fragile compound upsert
      const existing = await prisma.routineSlot.findFirst({
        where: {
          sectionId: section.id,
          ...(hasGroups && group ? { group } : {}),
          day: day,
          periodId: String(periodId),
        },
      });

      const slot = existing
        ? await prisma.routineSlot.update({
            where: { id: existing.id },
            data: {
              classSubjectId: String(classSubjectId),
              ...(room !== undefined
                ? { room: room ? String(room) : null }
                : {}),
            },
          })
        : await prisma.routineSlot.create({
            data: {
              sectionId: section.id,
              group: hasGroups ? group : null,
              day: day,
              periodId: String(periodId),
              classSubjectId: String(classSubjectId),
              room: room ? String(room) : null,
            },
          });

      res.json({ slot });
    } catch (err: any) {
      console.error("[routine] set slot:", err);
      res
        .status(500)
        .json({ error: err?.message || "Failed to set slot" });
    }
  },
);

// DELETE /api/admin/routine/slots/:slotId
router.delete(
  "/admin/routine/slots/:slotId",
  ...adminOnly,
  async (req, res) => {
    try {
      await prisma.routineSlot.delete({
        where: { id: req.params.slotId },
      });
      res.json({ message: "Slot cleared" });
    } catch (err: any) {
      console.error("[routine] delete slot:", err);
      res
        .status(500)
        .json({ error: err?.message || "Failed to clear slot" });
    }
  },
);

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

// PATCH /api/admin/periods/:id
// Body: { periodNumber?, label?, startTime?, endTime?, isBreak? }
router.patch("/admin/periods/:id", ...adminOnly, async (req, res) => {
  try {
    const { periodNumber, label, startTime, endTime, isBreak } = req.body;
    const data: any = {};
    if (periodNumber !== undefined) data.periodNumber = Number(periodNumber);
    if (label !== undefined) data.label = label;
    if (startTime !== undefined) data.startTime = startTime;
    if (endTime !== undefined) data.endTime = endTime;
    if (isBreak !== undefined) data.isBreak = !!isBreak;

    const period = await prisma.period.update({
      where: { id: req.params.id },
      data,
    });
    res.json({ period });
  } catch (err: any) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "A period with this number already exists" });
    }
    console.error("[periods] update:", err);
    res.status(500).json({ error: err?.message || "Failed to update period" });
  }
});
export default router;