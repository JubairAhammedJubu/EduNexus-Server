import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/session.js";
import { prisma } from "../lib/prisma.js";

const router = Router();

/**
 * GET /api/student/assignments
 *
 * Returns active assignments for the authenticated student's class and
 * section. Class and section are read from the student's profile, not from
 * query parameters.
 */
router.get(
  "/student/assignments",
  requireAuth,
  requireRole("student"),
  async (req, res) => {
    try {
      console.log("Student info:", req.user,)
      const student = await prisma.user.findUnique({
        where: { id: req.user!.id},
        select: {
          studentClass: true,
          studentSection: true,
        },
      }
      )

      if (!student?.studentClass) {
        return res.status(400).json({
          success: false,
          error: "Student class and section are required to fetch assignments.",
        });
      }

      const assignments = await prisma.assignment.findMany({
        where: {
          grade: student.studentClass,

          status: "ACTIVE",
        },
        orderBy: {
          dueDate: "asc",
        },
      });

      return res.json({
        success: true,
        count: assignments.length,
        assignments,
      });
    } catch (error: any) {
      console.error("Error fetching student assignments:", error);

      return res.status(500).json({
        success: false,
        error: error?.message || "Failed to fetch student assignments",
      });
    }
  },
);

/**
 * GET /api/teacher/assignments
 *
 * Optional query:
 * ?teacherEmail=teacher@example.com
 * ?status=ACTIVE
 */
router.get("/teacher/assignments", async (req, res) => {
  try {
    const { teacherEmail, status } = req.query;

    const whereClause: any = {};

    if (teacherEmail && typeof teacherEmail === "string") {
      whereClause.teacherEmail = teacherEmail;
    }

    if (status && typeof status === "string") {
      whereClause.status = status;
    }

    const assignments = await prisma.assignment.findMany({
      where: whereClause,
      orderBy: {
        dueDate: "asc",
      },
    });

    return res.json({
      success: true,
      assignments,
    });
  } catch (error: any) {
    console.error("Error fetching assignments:", error);

    return res.status(500).json({
      success: false,
      error: error?.message || "Failed to fetch assignments",
    });
  }
});
/**
 * POST /api/teacher/assignments
 *
 * Creates a new assignment.
 */
router.post("/teacher/assignments", async (req, res) => {
  try {
    const {
      title,
      description,
      subject,
      grade,
      section,
      dueDate,
      totalMarks,
      teacherEmail,
      teacherName,
      status,
    } = req.body;

    // Required fields
    if (!title || !subject || !grade || !section || !dueDate || !teacherEmail) {
      return res.status(400).json({
        success: false,
        error:
          "Title, description, subject, grade, section, due date, and teacher email are required.",
      });
    }

    const assignment = await prisma.assignment.create({
      data: {
        title: title.trim(),
        description: description?.trim() || null,
        subject: subject.trim(),
        grade: grade.trim(),
        section: section.trim(),
        dueDate: new Date(dueDate),
        totalMarks: Number(totalMarks) || 100,
        teacherEmail: teacherEmail.trim(),
        teacherName: teacherName?.trim() || null,
        status: status || "ACTIVE",
      },
    });

    return res.status(201).json({
      success: true,
      message: "Assignment created successfully.",
      assignment,
    });
  } catch (error: any) {
    console.error("Error creating assignment:", error);

    return res.status(500).json({
      success: false,
      error: error?.message || "Failed to create assignment",
    });
  }
});
/**
 * PATCH /api/teacher/assignments/:id
 *
 * Updates an existing assignment.
 */
router.patch("/teacher/assignments/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const {
      title,
      description,
      subject,
      grade,
      section,
      dueDate,
      totalMarks,
      teacherEmail,
      teacherName,
      status,
    } = req.body;

    if (!title || !subject || !grade || !section || !dueDate || !teacherEmail) {
      return res.status(400).json({
        success: false,
        error:
          "Title, description, subject, grade, section, due date, and teacher email are required.",
      });
    }

    const existingAssignment = await prisma.assignment.findUnique({
      where: { id },
    });

    if (!existingAssignment) {
      return res.status(404).json({
        success: false,
        error: "Assignment not found.",
      });
    }

    // Prevent a teacher from editing another teacher's assignment.
    if (existingAssignment.teacherEmail !== teacherEmail.trim()) {
      return res.status(403).json({
        success: false,
        error: "You are not authorized to edit this assignment.",
      });
    }

    const assignment = await prisma.assignment.update({
      where: { id },
      data: {
        title: title.trim(),
        description: description?.trim() || null,
        subject: subject.trim(),
        grade: grade.trim(),
        section: section.trim(),
        dueDate: new Date(dueDate),
        totalMarks: Number(totalMarks) || 100,
        teacherName: teacherName?.trim() || null,
        status: status || "ACTIVE",
      },
    });

    return res.json({
      success: true,
      message: "Assignment updated successfully.",
      assignment,
    });
  } catch (error: any) {
    console.error("Error updating assignment:", error);

    return res.status(500).json({
      success: false,
      error: error?.message || "Failed to update assignment",
    });
  }
});
/**
 * DELETE /api/teacher/assignments/:id
 *
 * Deletes an assignment.
 */
router.delete("/teacher/assignments/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { teacherEmail } = req.query;

    const existingAssignment = await prisma.assignment.findUnique({
      where: { id },
    });

    if (!existingAssignment) {
      return res.status(404).json({
        success: false,
        error: "Assignment not found.",
      });
    }

    // If teacherEmail is provided, verify ownership.
    if (
      teacherEmail &&
      typeof teacherEmail === "string" &&
      existingAssignment.teacherEmail !== teacherEmail
    ) {
      return res.status(403).json({
        success: false,
        error: "You are not authorized to delete this assignment.",
      });
    }

    await prisma.assignment.delete({
      where: { id },
    });

    return res.json({
      success: true,
      message: "Assignment deleted successfully.",
    });
  } catch (error: any) {
    console.error("Error deleting assignment:", error);

    return res.status(500).json({
      success: false,
      error: error?.message || "Failed to delete assignment",
    });
  }
});
export default router;
