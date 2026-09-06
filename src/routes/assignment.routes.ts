import { Router } from "express";
import multer from "multer";
import { requireAuth, requireRole } from "../middleware/session.js";
import { prisma } from "../lib/prisma.js";
import { getMaxPdfSizeBytes, uploadPdfToR2 } from "../lib/r2.js";

const router = Router();
const teacherOnly = [requireAuth, requireRole("teacher", "admin")];
const uploadPdf = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: getMaxPdfSizeBytes() },
});

function handlePdfUpload(req: any, res: any, next: any) {
  uploadPdf.single("file")(req, res, (error: any) => {
    if (error) {
      return res.status(400).json({
        success: false,
        error:
          error.code === "LIMIT_FILE_SIZE"
            ? "PDF must be 10 MB or smaller."
            : "A PDF file is required.",
      });
    }

    next();
  });
}

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
      const student = await prisma.user.findUnique({
        where: { id: req.user!.id },
        select: {
          studentClass: true,
          studentSection: true,
        },
      });

      if (!student?.studentClass || !student.studentSection) {
        return res.status(400).json({
          success: false,
          error: "Student class and section are required to fetch assignments.",
        });
      }

      const assignments = await prisma.assignment.findMany({
        where: {
          grade: student.studentClass,
          section: student.studentSection,
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
 * POST /api/student/assignments/:id/upload
 *
 * Uploads one PDF to Cloudflare R2 and returns its public URL.
 * Multipart field: file
 */
router.post(
  "/student/assignments/:id/upload",
  requireAuth,
  requireRole("student"),
  handlePdfUpload,
  async (req, res) => {
    try {
      const file = req.file;

      if (!file) {
        return res.status(400).json({
          success: false,
          error: "A PDF file is required in the 'file' field.",
        });
      }

      if (
        file.mimetype !== "application/pdf" ||
        !file.buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))
      ) {
        return res.status(400).json({
          success: false,
          error: "Only valid PDF files are allowed.",
        });
      }

      const { id: assignmentId } = req.params;
      const assignment = await prisma.assignment.findUnique({
        where: { id: assignmentId },
        select: {
          id: true,
          grade: true,
          section: true,
          status: true,
          dueDate: true,
        },
      });

      if (!assignment) {
        return res.status(404).json({
          success: false,
          error: "Assignment not found.",
        });
      }

      const student = await prisma.user.findUnique({
        where: { id: req.user!.id },
        select: { studentClass: true, studentSection: true },
      });

      if (
        !student?.studentClass ||
        !student.studentSection ||
        assignment.grade !== student.studentClass ||
        assignment.section !== student.studentSection
      ) {
        return res.status(403).json({
          success: false,
          error: "This assignment is not assigned to your section.",
        });
      }

      if (assignment.status === "CLOSED") {
        return res.status(400).json({
          success: false,
          error: "This assignment is closed and no longer accepts submissions.",
        });
      }

      const existingSubmission = await prisma.submission.findUnique({
        where: {
          assignmentId_studentId: {
            assignmentId,
            studentId: req.user!.id,
          },
        },
        select: { attemptsUsed: true, fileUrl: true },
      });

      const uploadAttemptsUsed = existingSubmission?.attemptsUsed ?? 1;

      if (uploadAttemptsUsed >= 2) {
        return res.status(409).json({
          success: false,
          error:
            "You have already used both submission attempts for this assignment.",
          attemptsUsed: 2,
          attemptsRemaining: 0,
        });
      }

      const fileUrl = await uploadPdfToR2(file, req.user!.id, assignmentId);
      const nextAttemptsUsed = existingSubmission ? uploadAttemptsUsed + 1 : 1;
      const submission = await prisma.submission.upsert({
        where: {
          assignmentId_studentId: {
            assignmentId,
            studentId: req.user!.id,
          },
        },
        create: {
          assignmentId,
          studentId: req.user!.id,
          studentEmail: req.user!.email,
          fileUrl,
          attemptsUsed: nextAttemptsUsed,
          status: new Date() > assignment.dueDate ? "LATE" : "SUBMITTED",
        },
        update: {
          fileUrl,
          attemptsUsed: nextAttemptsUsed,
          submittedAt: new Date(),
          status: new Date() > assignment.dueDate ? "LATE" : "SUBMITTED",
        },
      });

      return res.status(201).json({
        success: true,
        message: "PDF uploaded successfully.",
        fileUrl,
        attemptsUsed: nextAttemptsUsed,
        attemptsRemaining: 2 - nextAttemptsUsed,
        submission,
      });
    } catch (error: any) {
      console.error("Error uploading assignment PDF:", error);

      return res.status(500).json({
        success: false,
        error: error?.message || "Failed to upload PDF",
      });
    }
  },
);

/**
 * POST /api/student/assignments/:id/submit
 *
 * Creates or updates the authenticated student's submission for an assignment.
 * Body: { content?: string, fileUrl?: string }
 */
router.post(
  "/student/assignments/:id/submit",
  requireAuth,
  requireRole("student"),
  async (req, res) => {
    try {
      const { id: assignmentId } = req.params;
      const { content, fileUrl } = req.body;

      const submissionContent =
        typeof content === "string" ? content.trim() : "";
      const submissionFileUrl =
        typeof fileUrl === "string" ? fileUrl.trim() : "";

      if (!submissionContent && !submissionFileUrl) {
        return res.status(400).json({
          success: false,
          error: "Submission content or file URL is required.",
        });
      }

      const assignment = await prisma.assignment.findUnique({
        where: { id: assignmentId },
        select: { id: true, status: true, dueDate: true },
      });

      if (!assignment) {
        return res.status(404).json({
          success: false,
          error: "Assignment not found.",
        });
      }

      if (assignment.status === "CLOSED") {
        return res.status(400).json({
          success: false,
          error: "This assignment is closed and no longer accepts submissions.",
        });
      }

      const isLate = new Date() > assignment.dueDate;
      const existingSubmission = await prisma.submission.findUnique({
        where: {
          assignmentId_studentId: {
            assignmentId,
            studentId: req.user!.id,
          },
        },
        select: { attemptsUsed: true, fileUrl: true },
      });
      const sameUploadedFile =
        Boolean(submissionFileUrl) &&
        submissionFileUrl === existingSubmission?.fileUrl;
      const attemptsUsed = existingSubmission
        ? (existingSubmission.attemptsUsed ?? 1)
        : 0;

      if (attemptsUsed >= 2 && !sameUploadedFile) {
        return res.status(409).json({
          success: false,
          error:
            "You have already used both submission attempts for this assignment.",
          attemptsUsed: 2,
          attemptsRemaining: 0,
        });
      }

      const nextAttemptsUsed = sameUploadedFile
        ? attemptsUsed
        : attemptsUsed + 1;
      const submission = await prisma.submission.upsert({
        where: {
          assignmentId_studentId: {
            assignmentId,
            studentId: req.user!.id,
          },
        },
        create: {
          assignmentId,
          studentId: req.user!.id,
          studentEmail: req.user!.email,
          content: submissionContent || null,
          fileUrl: submissionFileUrl || existingSubmission?.fileUrl || null,
          attemptsUsed: nextAttemptsUsed,
          status: isLate ? "LATE" : "SUBMITTED",
        },
        update: {
          content: submissionContent || null,
          fileUrl: submissionFileUrl || existingSubmission?.fileUrl || null,
          attemptsUsed: nextAttemptsUsed,
          submittedAt: new Date(),
          status: isLate ? "LATE" : "SUBMITTED",
        },
      });

      return res.status(201).json({
        success: true,
        message:
          nextAttemptsUsed === 1
            ? "Assignment submitted successfully. You have one correction attempt remaining."
            : "Assignment correction submitted successfully. No attempts remain.",
        attemptsUsed: nextAttemptsUsed,
        attemptsRemaining: 2 - nextAttemptsUsed,
        submission,
      });
    } catch (error: any) {
      console.error("Error submitting assignment:", error);

      return res.status(500).json({
        success: false,
        error: error?.message || "Failed to submit assignment",
      });
    }
  },
);

/**
 * GET /api/teacher/assignment
 *
 * Optional query:
 * ?teacherEmail=teacher@example.com
 * ?status=ACTIVE
 */
router.get("/teacher/assignments", ...teacherOnly, async (req, res) => {
  try {
    const { status } = req.query;

    const whereClause: any =
      (req.user as { role?: string }).role === "admin"
        ? {}
        : { teacherEmail: req.user!.email };

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
router.post("/teacher/assignments", ...teacherOnly, async (req, res) => {
  try {
    const {
      title,
      description,
      subject,
      grade,
      section,
      dueDate,
      totalMarks,
      teacherName,
      status,
    } = req.body;

    // Required fields
<<<<<<< HEAD
    if (!title || !subject || !grade || !section || !dueDate) {
      return res.status(400).json({
        success: false,
        error: "Title, subject, grade, section, and due date are required.",
=======
    if (
      !title ||
      !description ||
      !subject ||
      !grade ||
      !section ||
      !dueDate ||
      !teacherEmail
    ) {
      return res.status(400).json({
        success: false,
        error:
          "Title, description, subject, grade, section, due date, and teacher email are required.",
>>>>>>> 08edd8408a8f53868612387aa0e74cf90f2ff342
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
        teacherEmail: req.user!.email,
        teacherName: req.user!.name || teacherName?.trim() || null,
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
router.patch("/teacher/assignments/:id", ...teacherOnly, async (req, res) => {
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
      teacherName,
      status,
    } = req.body;

<<<<<<< HEAD
    if (!title || !subject || !grade || !section || !dueDate) {
      return res.status(400).json({
        success: false,
        error: "Title, subject, grade, section, and due date are required.",
=======
    if (
      !title ||
      !description ||
      !subject ||
      !grade ||
      !section ||
      !dueDate ||
      !teacherEmail
    ) {
      return res.status(400).json({
        success: false,
        error:
          "Title, description, subject, grade, section, due date, and teacher email are required.",
>>>>>>> 08edd8408a8f53868612387aa0e74cf90f2ff342
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

    const isAdmin = (req.user as { role?: string }).role === "admin";
    if (!isAdmin && existingAssignment.teacherEmail !== req.user!.email) {
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
        teacherName: isAdmin
          ? teacherName?.trim() || null
          : req.user!.name || teacherName?.trim() || null,
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
router.delete("/teacher/assignments/:id", ...teacherOnly, async (req, res) => {
  try {
    const { id } = req.params;

    const existingAssignment = await prisma.assignment.findUnique({
      where: { id },
    });

    if (!existingAssignment) {
      return res.status(404).json({
        success: false,
        error: "Assignment not found.",
      });
    }

    const isAdmin = (req.user as { role?: string }).role === "admin";
    if (!isAdmin && existingAssignment.teacherEmail !== req.user!.email) {
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
