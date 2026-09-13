import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/session.js";
import { prisma } from "../lib/prisma.js";

const router = Router();

/**
 * POST /api/teacher/results
 * Create a student result
 */
router.post("/teacher/results", async (req, res) => {
  try {
    const {
      studentId,
      studentName,
      studentEmail,
      studentClass,
      assignmentId,
      exam,
      score,
      total,
      grade,
      status,
    } = req.body;

    // Required student information
    if (!studentId || !studentName || !studentEmail || !studentClass) {
      return res.status(400).json({
        success: false,
        error:
          "studentId, studentName, studentEmail, and studentClass are required.",
      });
    }

    // Required result information
    if (!exam || score === undefined || total === undefined || !grade) {
      return res.status(400).json({
        success: false,
        error: "Exam, score, total, and grade are required.",
      });
    }

    const numericScore = Number(score);
    const numericTotal = Number(total);

    if (!Number.isFinite(numericScore) || !Number.isFinite(numericTotal)) {
      return res.status(400).json({
        success: false,
        error: "Score and total must be valid numbers.",
      });
    }

    if (numericScore < 0 || numericTotal <= 0) {
      return res.status(400).json({
        success: false,
        error: "Score and total must contain valid positive values.",
      });
    }

    if (numericScore > numericTotal) {
      return res.status(400).json({
        success: false,
        error: "Score cannot be greater than total marks.",
      });
    }

    const result = await prisma.studentResult.create({
      data: {
        studentId: String(studentId).trim(),
        studentName: String(studentName).trim(),
        studentEmail: String(studentEmail).trim().toLowerCase(),
        studentClass: String(studentClass).trim(),

        assignmentId: assignmentId ? String(assignmentId).trim() : null,

        exam: String(exam).trim(),

        score: numericScore,
        total: numericTotal,

        grade: String(grade).trim(),

        status: status ? String(status).trim().toUpperCase() : "DRAFT",
      },
    });

    return res.status(201).json({
      success: true,
      message: "Result saved successfully.",
      result,
    });
  } catch (error: any) {
    console.error("Error creating result:", error);

    return res.status(500).json({
      success: false,
      error: error?.message || "Failed to save result.",
    });
  }
});

/**
 * GET /api/teacher/results
 * Get student results
 *
 * Optional query parameters:
 * ?studentEmail=student@example.com
 * ?status=PUBLISHED
 * ?assignmentId=assignment-id
 */
router.get("/teacher/results", async (req, res) => {
  try {
    const { studentEmail, status, assignmentId } = req.query;

    const whereClause: any = {};

    if (studentEmail && typeof studentEmail === "string") {
      whereClause.studentEmail = studentEmail.trim().toLowerCase();
    }

    if (status && typeof status === "string") {
      whereClause.status = status.trim().toUpperCase();
    }

    if (assignmentId && typeof assignmentId === "string") {
      whereClause.assignmentId = assignmentId.trim();
    }

    const results = await prisma.studentResult.findMany({
      where: whereClause,
      orderBy: {
        createdAt: "desc",
      },
    });

    return res.json({
      success: true,
      results,
    });
  } catch (error: any) {
    console.error("Error fetching results:", error);

    return res.status(500).json({
      success: false,
      error: error?.message || "Failed to fetch results.",
    });
  }
});
router.delete("/teacher/results/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: "Result ID is required.",
      });
    }

    const existingResult = await prisma.studentResult.findUnique({
      where: { id },
    });

    if (!existingResult) {
      return res.status(404).json({
        success: false,
        error: "Result not found.",
      });
    }

    await prisma.studentResult.delete({
      where: { id },
    });

    return res.json({
      success: true,
      message: "Result deleted successfully.",
    });
  } catch (error: any) {
    console.error("Error deleting result:", error);

    return res.status(500).json({
      success: false,
      error: error?.message || "Failed to delete result.",
    });
  }
});

router.patch("/teacher/results/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: "Result ID is required.",
      });
    }

    const existingResult = await prisma.studentResult.findUnique({
      where: { id },
    });

    if (!existingResult) {
      return res.status(404).json({
        success: false,
        error: "Result not found.",
      });
    }

    const {
      studentId,
      studentName,
      studentEmail,
      studentClass,
      assignmentId,
      exam,
      score,
      total,
      grade,
      status,
    } = req.body;

    if (
      !studentId ||
      !studentName ||
      !studentEmail ||
      !studentClass ||
      !exam ||
      score === undefined ||
      total === undefined ||
      !grade
    ) {
      return res.status(400).json({
        success: false,
        error: "All required result fields must be provided.",
      });
    }

    const updatedResult = await prisma.studentResult.update({
      where: { id },
      data: {
        studentId,
        studentName,
        studentEmail,
        studentClass,
        assignmentId: assignmentId || null,
        exam,
        score: Number(score),
        total: Number(total),
        grade,
        status: status || existingResult.status,
      },
    });

    return res.json({
      success: true,
      message: "Result updated successfully.",
      result: updatedResult,
    });
  } catch (error: any) {
    console.error("Error updating result:", error);

    return res.status(500).json({
      success: false,
      error: error?.message || "Failed to update result.",
    });
  }
});

router.get(
  "/student/results",
  requireAuth,
  requireRole("student"),
  async (req, res) => {
    try {
      const studentEmail = req.user!.email.toLowerCase();
      const { exam, assignmentId } = req.query;

      const where: any = {
        studentEmail,
        status: "PUBLISHED", // students can only see published results
      };

      if (exam && typeof exam === "string") {
        where.exam = exam.trim();
      }

      if (assignmentId && typeof assignmentId === "string") {
        where.assignmentId = assignmentId.trim();
      }

      const results = await prisma.studentResult.findMany({
        where,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          exam: true,
          score: true,
          total: true,
          grade: true,
          status: true,
          assignmentId: true,
          studentClass: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      console.log("Fetched student results:", results);
      return res.json({
        success: true,
        count: results.length,
        results,
      });
    } catch (error: any) {
      console.error("Error fetching student results:", error);
      return res.status(500).json({
        success: false,
        error: error?.message || "Failed to fetch results",
      });
    }
  },
);

/**
 * GET /api/student/results/:id
 * Get a single published result (only if it belongs to the student)
 */
router.get(
  "/student/results/:id",
  requireAuth,
  requireRole("student"),
  async (req, res) => {
    try {
      const { id } = req.params;

      const result = await prisma.studentResult.findFirst({
        where: {
          id,
          studentEmail: req.user!.email.toLowerCase(),
          status: "PUBLISHED",
        },
      });

      if (!result) {
        return res.status(404).json({
          success: false,
          error: "Result not found or not published yet.",
        });
      }

      return res.json({
        success: true,
        result,
      });
    } catch (error: any) {
      console.error("Error fetching result:", error);
      return res.status(500).json({
        success: false,
        error: error?.message || "Failed to fetch result",
      });
    }
  },
);

export default router;
