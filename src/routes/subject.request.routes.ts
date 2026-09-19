import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole } from "../middleware/session.js";

export const router = Router();
const adminOnly = [requireAuth, requireRole("admin")] as const;
// GET /api/admin/subject-requests?status=PENDING
router.get("/admin/subject-requests", ...adminOnly, async (req, res) => {
  try {
    const status = (req.query.status as string) || "PENDING";
    const requests = await prisma.classSubjectRequest.findMany({
      where: { status },
      orderBy: { createdAt: "desc" },
    });
    res.json({ requests });
  } catch (err: any) {
    console.error("[admin] list subject requests:", err);
    res.status(500).json({ error: err?.message || "Failed to load requests" });
  }
});

// PATCH /api/admin/subject-requests/:id/approve
router.patch("/admin/subject-requests/:id/approve", ...adminOnly, async (req, res) => {
  try {
    const request = await prisma.classSubjectRequest.findUnique({ where: { id: req.params.id } });
    if (!request) {
      return res.status(404).json({ error: "Request not found" });
    }
    if (request.status !== "PENDING") {
      return res.status(400).json({ error: `Request is already ${request.status}` });
    }

    // Resolve the actual class/section/subject records
    const schoolClass = await prisma.schoolClass.findFirst({ where: { name: request.grade } });
    if (!schoolClass) {
      return res.status(400).json({ error: `Class "${request.grade}" doesn't exist — create it first` });
    }

    const section = await prisma.classSection.findFirst({
      where: { classId: schoolClass.id, name: request.section },
    });
    if (!section) {
      return res.status(400).json({ error: `Section "${request.section}" doesn't exist under ${request.grade}` });
    }

    const subject = await prisma.subject.findFirst({ where: { name: request.subject } });
    if (!subject) {
      return res.status(400).json({
        error: `Subject "${request.subject}" isn't in the catalog — add it under Subjects first`,
      });
    }

    const teacher = await prisma.user.findUnique({ where: { email: request.teacherEmail } });
    if (!teacher || teacher.role !== "teacher") {
      return res.status(400).json({ error: "Requesting teacher account could not be found" });
    }

    // Attach the subject to this section if not already attached, then assign the teacher
    let classSubject = await prisma.classSubject.findFirst({
      where: { sectionId: section.id, subjectId: subject.id },
    });

    if (classSubject && classSubject.teacherId && classSubject.teacherId !== teacher.id) {
      return res.status(409).json({
        error: "This subject already has a different teacher assigned in this section — reassign manually if intended",
      });
    }

    if (!classSubject) {
      classSubject = await prisma.classSubject.create({
        data: {
          classId: schoolClass.id,
          sectionId: section.id,
          subjectId: subject.id,
          groupId: subject.groupId,
          teacherId: teacher.id,
        },
      });
    } else {
      classSubject = await prisma.classSubject.update({
        where: { id: classSubject.id },
        data: { teacherId: teacher.id },
      });
    }

    const updated = await prisma.classSubjectRequest.update({
      where: { id: request.id },
      data: { status: "APPROVED", adminFeedback: req.body.adminFeedback || "Approved" },
    });

    res.json({ request: updated, classSubject });
  } catch (err: any) {
    console.error("[admin] approve request:", err);
    res.status(500).json({ error: err?.message || "Failed to approve request" });
  }
});

// PATCH /api/admin/subject-requests/:id/reject
// Body: { adminFeedback }
router.patch("/admin/subject-requests/:id/reject", ...adminOnly, async (req, res) => {
  try {
    const reason = String(req.body.adminFeedback || "").trim();
    if (!reason) {
      return res.status(400).json({ error: "adminFeedback is required to reject" });
    }
    const request = await prisma.classSubjectRequest.update({
      where: { id: req.params.id },
      data: { status: "REJECTED", adminFeedback: reason },
    });
    res.json({ request });
  } catch (err: any) {
    console.error("[admin] reject request:", err);
    res.status(500).json({ error: err?.message || "Failed to reject request" });
  }
});

// ── Read-only class/subject data for teachers (no admin-only restriction) ──

// GET /api/teacher/meta/classes
router.get(
  "/teacher/meta/classes",
  requireAuth,
  requireRole("teacher"),
  async (req, res) => {
    try {
      const classes = await prisma.schoolClass.findMany({
        where: { isActive: true },
        include: { sections: { where: { isActive: true } } },
        orderBy: { order: "asc" },
      });
      res.json({ classes });
    } catch (err: any) {
      console.error("[teacher] meta classes:", err);
      res.status(500).json({ error: err?.message || "Failed to load classes" });
    }
  }
);

// GET /api/teacher/meta/subjects?groupId=
router.get(
  "/teacher/meta/subjects",
  requireAuth,
  requireRole("teacher"),
  async (req, res) => {
    try {
      const { groupId } = req.query as Record<string, string>;
      const subjects = await prisma.subject.findMany({
        where: {
          isActive: true,
          ...(groupId ? { OR: [{ groupId }, { isCore: true }] } : {}),
        },
        include: { group: true },
        orderBy: { name: "asc" },
      });
      res.json({ subjects });
    } catch (err: any) {
      console.error("[teacher] meta subjects:", err);
      res.status(500).json({ error: err?.message || "Failed to load subjects" });
    }
  }
);

// ── Teacher's subject-assignment requests ──────────────────────────────

// POST /api/teacher/subject-requests
router.post(
  "/teacher/subject-requests",
  requireAuth,
  requireRole("teacher"),
  async (req, res) => {
    try {
      const { grade, section, subject, subjectCode, group, room, schedule, time, reason } = req.body;

      if (!grade || !section || !subject || !subjectCode) {
        return res.status(400).json({ error: "grade, section, subject, and subjectCode are required" });
      }

      // Avoid duplicate pending requests for the same class/section/subject by this teacher
      const duplicate = await prisma.classSubjectRequest.findFirst({
        where: {
          teacherEmail: req.user!.email,
          grade,
          section,
          subject,
          status: "PENDING",
        },
      });
      if (duplicate) {
        return res.status(409).json({ error: "You already have a pending request for this exact assignment" });
      }

      const request = await prisma.classSubjectRequest.create({
        data: {
          teacherEmail: req.user!.email,
          teacherName: req.user!.name,
          grade,
          section,
          subject,
          subjectCode,
          group: group || null,
          room: room || null,
          schedule: schedule || null,
          time: time || null,
          reason: reason || null,
          status: "PENDING",
        },
      });

      res.status(201).json({ request });
    } catch (err: any) {
      console.error("[teacher] create request:", err);
      res.status(500).json({ error: err?.message || "Failed to submit request" });
    }
  }
);

// GET /api/teacher/subject-requests — own requests
router.get(
  "/teacher/subject-requests",
  requireAuth,
  requireRole("teacher"),
  async (req, res) => {
    try {
      const requests = await prisma.classSubjectRequest.findMany({
        where: { teacherEmail: req.user!.email },
        orderBy: { createdAt: "desc" },
      });
      res.json({ requests });
    } catch (err: any) {
      console.error("[teacher] list requests:", err);
      res.status(500).json({ error: err?.message || "Failed to load your requests" });
    }
  }
);


export default router;