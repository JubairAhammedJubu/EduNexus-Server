import { Router } from "express";
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
    if (
      !studentId ||
      !studentName ||
      !studentEmail ||
      !studentClass
    ) {
      return res.status(400).json({
        success: false,
        error:
          "studentId, studentName, studentEmail, and studentClass are required.",
      });
    }

    // Required result information
    if (
      !exam ||
      score === undefined ||
      total === undefined ||
      !grade
    ) {
      return res.status(400).json({
        success: false,
        error: "Exam, score, total, and grade are required.",
      });
    }

    const numericScore = Number(score);
    const numericTotal = Number(total);

    if (
      !Number.isFinite(numericScore) ||
      !Number.isFinite(numericTotal)
    ) {
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

        assignmentId: assignmentId
          ? String(assignmentId).trim()
          : null,

        exam: String(exam).trim(),

        score: numericScore,
        total: numericTotal,

        grade: String(grade).trim(),

        status: status
          ? String(status).trim().toUpperCase()
          : "DRAFT",
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
    const {
      studentEmail,
      status,
      assignmentId,
    } = req.query;

    const whereClause: any = {};

    if (
      studentEmail &&
      typeof studentEmail === "string"
    ) {
      whereClause.studentEmail = studentEmail
        .trim()
        .toLowerCase();
    }

    if (
      status &&
      typeof status === "string"
    ) {
      whereClause.status = status
        .trim()
        .toUpperCase();
    }

    if (
      assignmentId &&
      typeof assignmentId === "string"
    ) {
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

export default router;