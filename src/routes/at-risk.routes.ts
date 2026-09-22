import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/session.js";
import { prisma } from "../lib/prisma.js";
import { computeAtRiskScore, type RiskLevel } from "../lib/at-risk.js";
import { generateAtRiskInsight, AiInsightNotConfiguredError } from "../lib/ai-insight.js";

const router = Router();
const staffOnly = [requireAuth, requireRole("teacher", "admin")];

const RISK_ORDER: Record<RiskLevel, number> = {
  HIGH: 0,
  MEDIUM: 1,
  LOW: 2,
  INSUFFICIENT_DATA: 3,
};

/**
 * GET /api/teacher/at-risk
 *
 * Rule-based at-risk list for teacher/admin (SRS FR-11). Optional
 * ?grade= & ?section= narrow it to one class, matching how a teacher
 * would actually use this (their own students, not the whole school).
 * Nothing here calls Grok — this is pure, deterministic aggregation
 * from real attendance/results/assignment data, sorted highest-risk
 * first.
 */
router.get("/teacher/at-risk", ...staffOnly, async (req, res) => {
  try {
    const { grade, section } = req.query;

    const whereClause: any = { role: "student" };
    if (typeof grade === "string" && grade.trim()) whereClause.studentClass = grade.trim();
    if (typeof section === "string" && section.trim()) whereClause.studentSection = section.trim();

    const students = await prisma.user.findMany({
      where: whereClause,
      select: {
        id: true,
        name: true,
        email: true,
        studentClass: true,
        studentSection: true,
      },
      orderBy: { name: "asc" },
    });

    if (students.length === 0) {
      return res.json({ success: true, students: [] });
    }

    const studentIds = students.map((s) => s.id);

    // Bulk-fetch everything up front (3 queries total) instead of
    // per-student round trips.
    const [attendanceRecords, results, submissions] = await Promise.all([
      prisma.attendance.findMany({
        where: { studentId: { in: studentIds } },
        select: { studentId: true, status: true },
      }),
      prisma.studentResult.findMany({
        where: { studentId: { in: studentIds }, status: "PUBLISHED" },
        select: { studentId: true, score: true, total: true },
      }),
      prisma.submission.findMany({
        where: { studentId: { in: studentIds } },
        select: { studentId: true, assignmentId: true },
      }),
    ]);

    // Assignments actually assigned to each represented grade/section,
    // so "completion rate" is out of what was actually assigned to
    // that student's class, not the whole school's assignment count.
    const gradeSections = Array.from(
      new Set(students.map((s) => `${s.studentClass}|||${s.studentSection}`))
    ).map((key) => {
      const [g, sec] = key.split("|||");
      return { grade: g, section: sec };
    });

    const assignments = await prisma.assignment.findMany({
      where: {
        status: "ACTIVE",
        OR: gradeSections.map((gs) => ({ grade: gs.grade, section: gs.section })),
      },
      select: { id: true, grade: true, section: true },
    });

    const assignmentCountByClass = new Map<string, number>();
    for (const a of assignments) {
      const key = `${a.grade}|||${a.section}`;
      assignmentCountByClass.set(key, (assignmentCountByClass.get(key) ?? 0) + 1);
    }

    const attendanceByStudent = new Map<string, { total: number; presentOrLate: number }>();
    for (const r of attendanceRecords) {
      const entry = attendanceByStudent.get(r.studentId) ?? { total: 0, presentOrLate: 0 };
      entry.total += 1;
      if (r.status === "PRESENT" || r.status === "LATE") entry.presentOrLate += 1;
      attendanceByStudent.set(r.studentId, entry);
    }

    const resultsByStudent = new Map<string, { count: number; totalPercent: number }>();
    for (const r of results) {
      if (r.total <= 0) continue;
      const entry = resultsByStudent.get(r.studentId) ?? { count: 0, totalPercent: 0 };
      entry.count += 1;
      entry.totalPercent += (r.score / r.total) * 100;
      resultsByStudent.set(r.studentId, entry);
    }

    const submissionCountByStudent = new Map<string, number>();
    for (const s of submissions) {
      submissionCountByStudent.set(
        s.studentId,
        (submissionCountByStudent.get(s.studentId) ?? 0) + 1
      );
    }

    const scored = students.map((student) => {
      const attendance = attendanceByStudent.get(student.id) ?? { total: 0, presentOrLate: 0 };
      const resultEntry = resultsByStudent.get(student.id);
      const classKey = `${student.studentClass}|||${student.studentSection}`;
      const assignmentsAssigned = assignmentCountByClass.get(classKey) ?? 0;
      const assignmentsSubmitted = submissionCountByStudent.get(student.id) ?? 0;

      const score = computeAtRiskScore({
        attendanceTotal: attendance.total,
        attendancePresentOrLate: attendance.presentOrLate,
        resultsCount: resultEntry?.count ?? 0,
        averageScorePercent: resultEntry ? resultEntry.totalPercent / resultEntry.count : null,
        assignmentsAssigned,
        assignmentsSubmitted,
      });

      return {
        id: student.id,
        name: student.name,
        email: student.email,
        grade: student.studentClass,
        section: student.studentSection,
        ...score,
      };
    });

    scored.sort((a, b) => RISK_ORDER[a.riskLevel] - RISK_ORDER[b.riskLevel]);

    return res.json({ success: true, students: scored });
  } catch (error: any) {
    console.error("Error computing at-risk list:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Failed to compute at-risk list",
    });
  }
});

/**
 * POST /api/teacher/at-risk/:studentId/insight
 *
 * Generates a Grok-written note for ONE student, on demand — not
 * called automatically for the whole roster, so this only costs an
 * API call when a teacher actually asks for it. Recomputes the score
 * itself rather than trusting a client-supplied one, so the note is
 * always grounded in the current numbers.
 */
router.post("/teacher/at-risk/:studentId/insight", ...staffOnly, async (req, res) => {
  try {
    const { studentId } = req.params;

    const student = await prisma.user.findUnique({
      where: { id: studentId },
      select: { id: true, name: true, role: true, studentClass: true, studentSection: true },
    });
    if (!student || student.role !== "student") {
      return res.status(404).json({ success: false, error: "Student not found." });
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

    if (score.riskLevel === "INSUFFICIENT_DATA") {
      return res.status(400).json({
        success: false,
        error: "Not enough recorded data yet to generate an insight for this student.",
      });
    }

    const insight = await generateAtRiskInsight({
      studentName: student.name,
      riskLevel: score.riskLevel,
      attendanceRate: score.attendanceRate,
      averageScorePercent: score.averageScorePercent,
      assignmentCompletionRate: score.assignmentCompletionRate,
      reasons: score.reasons,
    });

    return res.json({ success: true, insight, riskLevel: score.riskLevel });
  } catch (error: any) {
    if (error instanceof AiInsightNotConfiguredError) {
      return res.status(503).json({
        success: false,
        error: "AI insights aren't configured on this server yet (missing GROQ_API_KEY).",
      });
    }
    console.error("Error generating at-risk insight:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Failed to generate insight",
    });
  }
});

export default router;