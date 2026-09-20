
// ── List all classes with their sections ──────────────────────────────────
import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole } from "../middleware/session.js";

export const router = Router();
export const adminOnly = [requireAuth, requireRole("admin")] as const;


// GET /api/admin/classes
router.get("/admin/classes",...adminOnly, async (req, res) => {
  try {
    const classes = await prisma.schoolClass.findMany({
      where: { isActive: true },
      include: { sections: { where: { isActive: true } } },
      orderBy: { order: "asc" },
    });
    res.json({ classes });
  } catch (err: any) {
    console.error("[classes] list:", err);
    res.status(500).json({ error: err?.message || "Failed to load classes" });
  }
});

// ── Create a class ──────────────────────────────────────────────────────

// POST /api/admin/classes
// Body: { name, order, sessionYear }
router.post("/admin/classes", ...adminOnly, async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const order = Number(req.body.order) || 0;
    const sessionYear = String(
      req.body.sessionYear || new Date().getFullYear(),
    );

    if (!name) {
      return res.status(400).json({ error: "Class name is required" });
    }

    const existing = await prisma.schoolClass.findFirst({
      where: { name, sessionYear },
    });
    if (existing) {
      return res
        .status(409)
        .json({ error: "This class already exists for this session" });
    }

    const schoolClass = await prisma.schoolClass.create({
      data: { name, order, sessionYear },
    });

    res.status(201).json({ class: schoolClass });
  } catch (err: any) {
    console.error("[classes] create:", err);
    res.status(500).json({ error: err?.message || "Failed to create class" });
  }
});

// ── Create a section under a class ─────────────────────────────────────

// POST /api/admin/classes/:classId/sections
// Body: { name, capacity? }
router.post(
  "/admin/classes/:classId/sections",
  ...adminOnly,
  async (req, res) => {
    try {
      const { classId } = req.params;
      const name = String(req.body.name || "").trim();
      

      if (!name) {
        return res.status(400).json({ error: "Section name is required" });
      }

      const schoolClass = await prisma.schoolClass.findUnique({
        where: { id: classId },
      });
      if (!schoolClass) {
        return res.status(404).json({ error: "Class not found" });
      }

      const existing = await prisma.classSection.findFirst({
        where: { classId, name },
      });
      if (existing) {
        return res
          .status(409)
          .json({ error: "This section already exists for this class" });
      }

      const section = await prisma.classSection.create({
        data: { classId, name, capacity:30 },
      });

      res.status(201).json({ section });
    } catch (err: any) {
      console.error("[classes] create section:", err);
      res
        .status(500)
        .json({ error: err?.message || "Failed to create section" });
    }
  },
);

// ── Seed Class 6–10 with Section A & B ─────────────────────────────────

// POST /api/admin/classes/seed
router.post("/admin/classes/seed", ...adminOnly, async (req, res) => {
  try {
    const sessionYear = new Date().getFullYear().toString();
    const created: any[] = [];

    for (let order = 6; order <= 10; order++) {
      const name = `Class ${order}`;

      let schoolClass = await prisma.schoolClass.findFirst({
        where: { name, sessionYear },
      });
      if (!schoolClass) {
        schoolClass = await prisma.schoolClass.create({
          data: { name, order, sessionYear, hasGroups: order >= 9 },
        });
      }

      for (const sectionName of ["Section A", "Section B"]) {
        const existing = await prisma.classSection.findFirst({
          where: { classId: schoolClass.id, name: sectionName },
        });
        if (!existing) {
          await prisma.classSection.create({
            data: { classId: schoolClass.id, name: sectionName },
          });
        }
      }

      created.push(schoolClass);
    }

    res.json({
      message: "Seeded Class 6–10 with Section A & B",
      classes: created,
    });
  } catch (err: any) {
    console.error("[classes] seed:", err);
    res.status(500).json({ error: err?.message || "Seed failed" });
  }
});

// router.delete("/admin/classes/:id",async(req,res)=>{
//   const {id} = req.params;
//   const dataDelete = await prisma.schoolClass.delete({
//     where:{id: id},
//   })
//   res.send(dataDelete)
// })

// ── Section detail (for the drawer) ────────────────────────────────────

// GET /api/admin/classes/sections/:sectionId
router.get(
  "/admin/classes/sections/:sectionId",
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

      const [students, teacher, substituteTeacher] = await Promise.all([
        prisma.user.findMany({
          where: {
            role: "student",
            studentClass: section.schoolClass.name,
            studentSection: section.name,
          },
          select: { id: true, name: true, email: true, roll: true },
          orderBy: { roll: "asc" },
        }),
        section.teacherId
          ? prisma.user.findUnique({
              where: { id: section.teacherId },
              select: { id: true, name: true, email: true },
            })
          : null,
        section.substituteTeacherId
          ? prisma.user.findUnique({
              where: { id: section.substituteTeacherId },
              select: { id: true, name: true, email: true },
            })
          : null,
      ]);

      res.json({
        section: {
          id: section.id,
          name: section.name,
          capacity: section.capacity,
        },
        class: { id: section.schoolClass.id, name: section.schoolClass.name },
        totalStudents: students.length,
        students,
        teacher,
        substituteTeacher,
      });
    } catch (err: any) {
      console.error("[classes] section detail:", err);
      res.status(500).json({ error: err?.message || "Failed to load section" });
    }
  },
);

// ── Teacher list (for assign dropdowns) ────────────────────────────────

// GET /api/admin/teachers
router.get("/admin/teachers",  async (req, res) => {
  try {
    const teachers = await prisma.user.findMany({
      where: { role: "teacher" },
      select: { id: true, name: true, email: true },
      orderBy: { name: "asc" },
    });
    res.json({ teachers });
  } catch (err: any) {
    console.error("[classes] teacher list:", err);
    res.status(500).json({ error: err?.message || "Failed to load teachers" });
  }
});

// ── Assign class teacher ───────────────────────────────────────────────

// PATCH /api/admin/classes/sections/:sectionId/teacher
// Body: { teacherId: string | null }
router.patch(
  "/admin/classes/sections/:sectionId/teacher",
  ...adminOnly,
  async (req, res) => {
    try {
      const { teacherId } = req.body;

      if (teacherId) {
        const teacher = await prisma.user.findUnique({
          where: { id: teacherId },
        });
        if (!teacher || teacher.role !== "teacher") {
          return res.status(404).json({ error: "Teacher not found" });
        }
      }
      const alreadyAssign = await prisma.classSection.findFirst({
        where:{
          teacherId,
          id:{not:req.params.sectionId}
        }
      })
    if(alreadyAssign){
      return res.status(409).json({
         error: "This teacher is already assigned as a class teacher.",
      })
    }
      
      const section = await prisma.classSection.update({
        where: { id: req.params.sectionId },
        data: { teacherId: teacherId || null },
      });
 
      res.json({ section });
    } catch (err: any) {
      console.error("[classes] assign teacher:", err);
      res
        .status(500)
        .json({ error: err?.message || "Failed to assign teacher" });
    }
  },
);

// ── Assign / remove substitute teacher ─────────────────────────────────

// PATCH /api/admin/classes/sections/:sectionId/substitute
// Body: { teacherId: string | null }
router.patch(
  "/admin/classes/sections/:sectionId/substitute",
  ...adminOnly,
  async (req, res) => {
    try {
      const { teacherId } = req.body;

      if (teacherId) {
        const teacher = await prisma.user.findUnique({
          where: { id: teacherId },
        });
        if (!teacher || teacher.role !== "teacher") {
          return res.status(404).json({ error: "Teacher not found" });
        }
      }

      const section = await prisma.classSection.update({
        where: { id: req.params.sectionId },
        data: { substituteTeacherId: teacherId || null },
      });

      res.json({ section });
    } catch (err: any) {
      console.error("[classes] assign substitute:", err);
      res
        .status(500)
        .json({ error: err?.message || "Failed to assign substitute" });
    }
  },
);

// ── Class-section subject assignment ─────────────────────────────────────

// GET /api/admin/classes/sections/:sectionId/subjects
router.get(
  "/admin/classes/sections/:sectionId/subjects",
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

      const classSubjects = await prisma.classSubject.findMany({
        where: { sectionId: section.id },
        include: { subject: { include: { group: true } } },
        orderBy: { subject: { name: "asc" } },
      });

      const teacherIds = [
        ...new Set(
          classSubjects.flatMap((cs) =>
            [cs.teacherId, cs.substituteTeacherId].filter(Boolean),
          ),
        ),
      ] as string[];
      const teachers = teacherIds.length
        ? await prisma.user.findMany({
            where: { id: { in: teacherIds } },
            select: { id: true, name: true, email: true },
          })
        : [];
      const teacherMap = Object.fromEntries(teachers.map((t) => [t.id, t]));

      const rows = classSubjects.map((cs) => ({
        id: cs.id,
        subject: {
          id: cs.subject.id,
          name: cs.subject.name,
          code: cs.subject.code,
          group: cs.subject.group?.name ?? null,
        },
        teacher: cs.teacherId ? (teacherMap[cs.teacherId] ?? null) : null,
        substituteTeacher: cs.substituteTeacherId
          ? (teacherMap[cs.substituteTeacherId] ?? null)
          : null,
      }));

      res.json({
        section: { id: section.id, name: section.name },
        class: {
          id: section.schoolClass.id,
          name: section.schoolClass.name,
          hasGroups: section.schoolClass.hasGroups,
        },
        subjects: rows,
      });
    } catch (err: any) {
      console.error("[classes] section subjects:", err);
      res
        .status(500)
        .json({ error: err?.message || "Failed to load subjects" });
    }
  },
);

// POST /api/admin/classes/sections/:sectionId/subjects
// Body: { subjectId } — attaches a subject to this section (no teacher yet)
router.post(
  "/admin/classes/sections/:sectionId/subjects",
  ...adminOnly,
  async (req, res) => {
    try {
      const { subjectId } = req.body;
      if (!subjectId) {
        return res.status(400).json({ error: "subjectId is required" });
      }

      const section = await prisma.classSection.findUnique({
        where: { id: req.params.sectionId },
      });
      if (!section) {
        return res.status(404).json({ error: "Section not found" });
      }

      const subject = await prisma.subject.findUnique({
        where: { id: subjectId },
      });
      if (!subject) {
        return res.status(404).json({ error: "Subject not found" });
      }

      const classSubject = await prisma.classSubject.create({
        data: {
          classId: section.classId,
          sectionId: section.id,
          subjectId,
          groupId: subject.groupId,
        },
      });

      res.status(201).json({ classSubject });
    } catch (err: any) {
      if (err.code === "P2002") {
        return res
          .status(409)
          .json({ error: "This subject is already added to this section" });
      }
      console.error("[classes] add subject:", err);
      res.status(500).json({ error: err?.message || "Failed to add subject" });
    }
  },
);

// DELETE /api/admin/classes/subjects/:classSubjectId
router.delete(
  "/admin/classes/subjects/:classSubjectId",
  ...adminOnly,
  async (req, res) => {
    try {
      await prisma.classSubject.delete({
        where: { id: req.params.classSubjectId },
      });
      res.json({ message: "Removed" });
    } catch (err: any) {
      console.error("[classes] remove subject:", err);
      res
        .status(500)
        .json({ error: err?.message || "Failed to remove subject" });
    }
  },
);

// PATCH /api/admin/classes/subjects/:classSubjectId/teacher
// Body: { teacherId: string | null }
router.patch(
  "/admin/classes/subjects/:classSubjectId/teacher",
  ...adminOnly,
  async (req, res) => {
    try {
      const { teacherId } = req.body;

      if (teacherId) {
        const teacher = await prisma.user.findUnique({
          where: { id: teacherId },
        });
        if (!teacher || teacher.role !== "teacher") {
          return res.status(404).json({ error: "Teacher not found" });
        }
      }

      const classSubject = await prisma.classSubject.update({
        where: { id: req.params.classSubjectId },
        data: { teacherId: teacherId || null },
      });

      res.json({ classSubject });
    } catch (err: any) {
      console.error("[classes] assign subject teacher:", err);
      res
        .status(500)
        .json({ error: err?.message || "Failed to assign teacher" });
    }
  },
);

// PATCH /api/admin/classes/subjects/:classSubjectId/substitute
// Body: { teacherId: string | null }
router.patch(
  "/admin/classes/subjects/:classSubjectId/substitute",
  ...adminOnly,
  async (req, res) => {
    try {
      const { teacherId } = req.body;

      if (teacherId) {
        const teacher = await prisma.user.findUnique({
          where: { id: teacherId },
        });
        if (!teacher || teacher.role !== "teacher") {
          return res.status(404).json({ error: "Teacher not found" });
        }
      }

      const classSubject = await prisma.classSubject.update({
        where: { id: req.params.classSubjectId },
        data: { substituteTeacherId: teacherId || null },
      });

      res.json({ classSubject });
    } catch (err: any) {
      console.error("[classes] assign subject substitute:", err);
      res
        .status(500)
        .json({ error: err?.message || "Failed to assign substitute" });
    }
  },
);


/**
 * GET /api/teacher/assignments
 * Classes/sections/subjects where this teacher is assigned
 * (class teacher, subject teacher, or substitute)
 */
router.get(
  "/teacher/assign",
  requireAuth,
  requireRole("teacher"),
  async (req, res) => {
    try {
      const teacherId = req.user!.id;

      // Section-level: class teacher / substitute
      const sections = await prisma.classSection.findMany({
        where: {
          isActive: true,
          OR: [{ teacherId }, { substituteTeacherId: teacherId }],
        },
        include: {
          schoolClass: {
            select: { id: true, name: true, hasGroups: true, order: true },
          },
        },
        orderBy: { name: "asc" },
      });

      // Subject-level: teaches this subject in a section
      const classSubjects = await prisma.classSubject.findMany({
        where: {
          OR: [{ teacherId }, { substituteTeacherId: teacherId }],
        },
        include: {
          subject: { include: { group: true } },
          // need section + class — adjust relation names to your schema
        },
      });

      // If ClassSubject has sectionId only:
      const sectionIds = [
        ...new Set(classSubjects.map((cs: any) => cs.sectionId).filter(Boolean)),
      ];
      const subjectSections = sectionIds.length
        ? await prisma.classSection.findMany({
            where: { id: { in: sectionIds } },
            include: {
              schoolClass: {
                select: { id: true, name: true, hasGroups: true },
              },
            },
          })
        : [];
      const sectionMap = Object.fromEntries(
        subjectSections.map((s) => [s.id, s]),
      );

      const asClassTeacher = sections.map((s) => ({
        sectionId: s.id,
        sectionName: s.name,
        className: s.schoolClass.name,
        classId: s.schoolClass.id,
        role:
          s.teacherId === teacherId ? "CLASS_TEACHER" : "SUBSTITUTE_CLASS_TEACHER",
      }));

      const asSubjectTeacher = classSubjects.map((cs: any) => {
        const sec = sectionMap[cs.sectionId];
        return {
          classSubjectId: cs.id,
          subjectName: cs.subject?.name,
          subjectCode: cs.subject?.code,
          group: cs.subject?.group?.name ?? null,
          sectionId: cs.sectionId,
          sectionName: sec?.name ?? null,
          className: sec?.schoolClass?.name ?? null,
          role:
            cs.teacherId === teacherId
              ? "SUBJECT_TEACHER"
              : "SUBSTITUTE_SUBJECT_TEACHER",
        };
      });

      res.json({
        success: true,
        asClassTeacher,
        asSubjectTeacher,
      });
    } catch (err: any) {
      console.error("[teacher] assignments:", err);
      res.status(500).json({
        error: err?.message || "Failed to load assignments",
      });
    }
  },
);
export default router;