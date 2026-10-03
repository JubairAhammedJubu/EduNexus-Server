import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole } from "../middleware/session.js";

const router = Router();
const staffOnly = [requireAuth, requireRole("teacher", "admin")] as const;

/**
 * GET /api/exams
 * Returns all examination records sorted newest first.
 */
router.get("/exams", async (_req, res) => {
  try {
    const exams = await prisma.exam.findMany({
      orderBy: { createdAt: "desc" },
    });

    return res.json({
      success: true,
      exams,
    });
  } catch (error: any) {
    console.error("Error fetching examinations:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Failed to fetch examinations",
    });
  }
});

/**
 * POST /api/exams
 * Creates a new examination entry in MongoDB `examinations` collection.
 */
router.post("/exams", ...staffOnly, async (req, res) => {
  try {
    const {
      title,
      subject,
      studentClass,
      section,
      group,
      examType,
      date,
      startTime,
      endTime,
      roomNo,
      totalMarks,
      passingMarks,
      invigilator,
      isYourDuty,
      syllabus,
      teacherEmail,
    } = req.body;

    if (!title || !subject || !studentClass || !date) {
      return res.status(400).json({
        success: false,
        error: "Title, Subject, Class, and Date are required fields.",
      });
    }

    const parsedTotalMarks = parseInt(String(totalMarks), 10) || 100;
    const parsedPassingMarks = parseInt(String(passingMarks), 10) || 40;

    const newExam = await prisma.exam.create({
      data: {
        title,
        subject,
        studentClass,
        section: section || "Section A",
        group: group || null,
        examType: examType || "Mid-Term",
        date,
        startTime: startTime || "09:00 AM",
        endTime: endTime || "11:30 AM",
        roomNo: roomNo || "Hall 101",
        totalMarks: parsedTotalMarks,
        passingMarks: parsedPassingMarks,
        invigilator: invigilator || "Unassigned",
        isYourDuty: typeof isYourDuty === "boolean" ? isYourDuty : true,
        syllabus: syllabus || "",
        status: "Upcoming",
        teacherEmail:
          req.user!.role === "admin" ? teacherEmail || null : req.user!.email,
      },
    });

    return res.status(201).json({
      success: true,
      message: "Examination created and saved successfully!",
      exam: newExam,
    });
  } catch (error: any) {
    console.error("Error creating examination:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Failed to create examination",
    });
  }
});

/**
 * PATCH /api/exams/:id/cancel
 * Cancels an examination by updating its status to "Cancelled".
 */
router.patch("/exams/:id/cancel", ...staffOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const exam = await prisma.exam.findUnique({ where: { id } });
    if (!exam) return res.status(404).json({ error: "Examination not found" });
    if (req.user!.role !== "admin" && exam.teacherEmail !== req.user!.email) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const updated = await prisma.exam.update({
      where: { id },
      data: { status: "Cancelled" },
    });

    return res.json({
      success: true,
      message: "Examination cancelled successfully!",
      exam: updated,
    });
  } catch (error: any) {
    console.error("Error cancelling examination:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Failed to cancel examination",
    });
  }
});

export default router;
