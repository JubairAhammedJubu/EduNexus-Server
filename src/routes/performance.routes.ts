import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/session.js";
import { prisma } from "../lib/prisma.js";
import { computeAtRiskScore, type AtRiskScore } from "../lib/at-risk.js";
import { generatePerformanceInsight } from "../lib/ai-insight.js";

const router = Router();
const studentOnly = [requireAuth, requireRole("student")];

/**
 * Loads the logged-in student's profile and scores them with the exact
 * same deterministic engine used for the teacher-facing at-risk list
 * (see lib/at-risk.ts), so a student and their teacher always see
 * numbers that agree with each other.
 */
async function loadOwnStudentScore(
  studentId: string
): Promise<{ studentName: string; score: AtRiskScore } | null> {
  const student = await prisma.user.findUnique({
    where: { id: studentId },
    select: { id: true, name: true, role: true, studentClass: true, studentSection: true },
  });
  if (!student || student.role !== "student") {
    return null;
  }

  const [attendanceRecords, results, assignmentsAssigned, submissionsCount] = await Promise.all([
    prisma.attendance.findMany({
      where: { studentId },
      select: { status: true },
    }),
    prisma.studentResult.findMany({
      where: { studentId, status: "PUBLISHED" },
      select: { score: true, total: true },
    }),
    prisma.assignment.count({
      where: {
        status: "ACTIVE",
        grade: student.studentClass ?? undefined,
        section: student.studentSection ?? undefined,
      },
    }),
    prisma.submission.count({ where: { studentId } }),
  ]);

  const attendanceTotal = attendanceRecords.length;
  const attendancePresentOrLate = attendanceRecords.filter(
    (r) => r.status === "PRESENT" || r.status === "LATE"
  ).length;

  const validResults = results.filter((r) => r.total > 0);
  const averageScorePercent =
    validResults.length > 0
      ? validResults.reduce((sum, r) => sum + (r.score / r.total) * 100, 0) / validResults.length
      : null;

  const score = computeAtRiskScore({
    attendanceTotal,
    attendancePresentOrLate,
    resultsCount: validResults.length,
    averageScorePercent,
    assignmentsAssigned,
    assignmentsSubmitted: submissionsCount,
  });

  return { studentName: student.name, score };
}

/**
 * GET /api/student/performance
 *
 * The logged-in student's own attendance + result + assignment
 * snapshot. Purely deterministic (no AI call here) — the same
 * rule-based scoring the teacher view uses.
 */
router.get("/student/performance", ...studentOnly, async (req, res) => {
  try {
    const studentId = req.user!.id;
    const loaded = await loadOwnStudentScore(studentId);

    if (!loaded) {
      return res.status(404).json({ success: false, error: "Student profile not found." });
    }

    return res.json({
      success: true,
      studentName: loaded.studentName,
      ...loaded.score,
    });
  } catch (error: any) {
    console.error("Error computing student performance:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Failed to compute performance snapshot.",
    });
  }
});

/**
 * POST /api/student/performance/insight
 *
 * A short, encouraging note generated from the student's own numbers,
 * written directly to them. Uses Groq when GROQ_API_KEY is set;
 * otherwise (or if the call fails) falls back to a deterministic,
 * template-based note — this endpoint always returns a usable insight,
 * with zero required external setup.
 */
router.post("/student/performance/insight", ...studentOnly, async (req, res) => {
  try {
    const studentId = req.user!.id;
    const loaded = await loadOwnStudentScore(studentId);

    if (!loaded) {
      return res.status(404).json({ success: false, error: "Student profile not found." });
    }

    const { studentName, score } = loaded;

    if (score.riskLevel === "INSUFFICIENT_DATA") {
      return res.status(400).json({
        success: false,
        error: "Not enough recorded attendance, results, or assignment data yet to generate an insight.",
      });
    }

    const insight = await generatePerformanceInsight({
      studentName,
      perspective: "student",
      riskLevel: score.riskLevel,
      attendanceRate: score.attendanceRate,
      averageScorePercent: score.averageScorePercent,
      assignmentCompletionRate: score.assignmentCompletionRate,
      reasons: score.reasons,
    });

    return res.json({
      success: true,
      insight: insight.text,
      source: insight.source,
      riskLevel: score.riskLevel,
    });
  } catch (error: any) {
    console.error("Error generating student performance insight:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Failed to generate insight.",
    });
  }
});

export default router;
