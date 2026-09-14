import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/session.js";
import { prisma } from "../lib/prisma.js";

const router = Router();
const teacherOrAdmin = [requireAuth, requireRole("teacher", "admin")];

/**
 * GET /api/teacher/requests
 * Accepts query params: ?teacherEmail=... or ?status=...
 * Returns matching classSubjectRequest records sorted newest first.
 */
router.get("/teacher/requests", ...teacherOrAdmin, async (req, res) => {
  try {
    const { status } = req.query;

    const isAdmin = (req.user as { role?: string }).role === "admin";
    const whereClause: any = isAdmin ? {} : { teacherEmail: req.user!.email };
    if (status && typeof status === "string") {
      whereClause.status = status;
    }

    const requests = await prisma.classSubjectRequest.findMany({
      where: whereClause,
      orderBy: { createdAt: "desc" },
    });

    return res.json({
      success: true,
      requests,
    });
  } catch (error: any) {
    console.error("Error fetching class & subject requests:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Failed to fetch requests",
    });
  }
});

/**
 * POST /api/teacher/requests
 * Creates a new class & subject request.
 * Body: { teacherEmail, teacherName, grade, section, subject, subjectCode, room, schedule, time, reason }
 */
router.post("/teacher/requests", ...teacherOrAdmin, async (req, res) => {
  try {
    const {
      teacherName,
      grade,
      section,
      subject,
      subjectCode,
      group,
      room,
      schedule,
      time,
      reason,
    } = req.body;

    if (!grade || !section || !subject) {
      return res.status(400).json({
        success: false,
        error: "Grade, section, and subject are required fields.",
      });
    }

    const newRequest = await prisma.classSubjectRequest.create({
      data: {
        teacherEmail: req.user!.email,
        teacherName: req.user!.name || teacherName || "Teacher",
        grade,
        section,
        subject,
        subjectCode:
          subjectCode ||
          `${subject.substring(0, 4).toUpperCase()}-${grade.replace(/[^0-9]/g, "") || "01"}${section.charAt(0)}`,
        group: group || null,
        room: room || "Room TBD",
        schedule: schedule || "Sun · Tue · Thu",
        time: time || "09:00 AM – 10:00 AM",
        reason: reason || "",
        status: "PENDING",
      } as any,
    });

    return res.status(201).json({
      success: true,
      message: "Class & Subject request submitted successfully!",
      request: newRequest,
    });
  } catch (error: any) {
    console.error("Error creating request:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Failed to create request",
    });
  }
});

/**
 * DELETE /api/teacher/requests/:id
 * Cancels/Deletes a pending request.
 */
router.delete("/teacher/requests/:id", ...teacherOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await prisma.classSubjectRequest.findUnique({
      where: { id },
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        error: "Request record not found",
      });
    }

    const isAdmin = (req.user as { role?: string }).role === "admin";
    if (!isAdmin && existing.teacherEmail !== req.user!.email) {
      return res
        .status(403)
        .json({ error: "You are not authorized to delete this request." });
    }

    await prisma.classSubjectRequest.delete({
      where: { id },
    });

    return res.json({
      success: true,
      message: "Request deleted successfully",
    });
  } catch (error: any) {
    console.error("Error deleting request:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Failed to delete request",
    });
  }
});

/**
 * PATCH /api/admin/requests/:id
 * Updates request status to APPROVED or REJECTED with optional admin feedback.
 * Body: { status: "APPROVED" | "REJECTED", adminFeedback?: string }
 */
router.patch(
  "/admin/requests/:id",
  ...[requireAuth, requireRole("admin")],
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status, adminFeedback } = req.body;

      if (!["APPROVED", "REJECTED", "PENDING"].includes(status)) {
        return res.status(400).json({
          success: false,
          error:
            "Invalid status value. Must be PENDING, APPROVED, or REJECTED.",
        });
      }

      const existingRequest = await prisma.classSubjectRequest.findUnique({
        where: { id },
      });

      if (!existingRequest) {
        return res.status(404).json({
          success: false,
          error: "Request record not found.",
        });
      }

      const updated = await prisma.classSubjectRequest.update({
        where: { id },
        data: {
          status,
          ...(adminFeedback !== undefined ? { adminFeedback } : {}),
        },
      });

      // If approved, update the new teacher's assignedClass & assignedSubject in User table
      if (status === "APPROVED" && existingRequest.teacherEmail) {
        const fullClass = `${existingRequest.grade} ${existingRequest.section}`;

        // Update requesting teacher's department/class allocation
        await prisma.user.updateMany({
          where: { email: existingRequest.teacherEmail },
          data: {
            studentClass: fullClass,
            department: existingRequest.subject,
          },
        });
      }

      return res.json({
        success: true,
        message:
          status === "APPROVED"
            ? `Request approved! Class ${existingRequest.grade} ${existingRequest.section} (${existingRequest.subject}) assigned to ${existingRequest.teacherName}.`
            : `Request status updated to ${status}.`,
        request: updated,
      });
    } catch (error: any) {
      console.error("Error updating request status:", error);
      return res.status(500).json({
        success: false,
        error: error?.message || "Failed to update request status",
      });
    }
  },
);

/**
 * GET /api/student/subjects
 *
 * Returns approved subjects for the logged-in student's class.
 * Optional: also filter by section.
 */
router.get(
  "/student/subjects",
  requireAuth,
  requireRole("student"),
  async (req, res) => {
    try {
      const student = await prisma.user.findUnique({
        where: { id: req.user!.id },
        select: {
          studentClass: true,
          studentSection: true,
          department: true,
        },
      });

      if (!student?.studentClass) {
        return res.status(400).json({
          success: false,
          error: "Student class is required.",
        });
      }

      const defaultSubjectsByClass: Record<string, Record<string, string[]>> = {
        "Class 6": {
          General: [
            "Bangla",
            "English",
            "Mathematics",
            "Science",
            "Bangladesh & Global Studies",
            "Religion",
            "ICT",
            "Physical Education & Health",
            "Arts & Crafts",
          ],
        },
        "Class 7": {
          General: [
            "Bangla",
            "English",
            "Mathematics",
            "Science",
            "Bangladesh & Global Studies",
            "Religion",
            "ICT",
            "Physical Education & Health",
            "Arts & Crafts",
          ],
        },
        "Class 8": {
          General: [
            "Bangla",
            "English",
            "Mathematics",
            "Science",
            "Bangladesh & Global Studies",
            "Religion",
            "ICT",
            "Physical Education & Health",
            "Arts & Crafts",
          ],
        },

        "Class 9": {
          Science: [
            "Bangla 1st Paper",
            "Bangla 2nd Paper",
            "English 1st Paper",
            "English 2nd Paper",
            "General Mathematics",
            "Higher Mathematics",
            "Physics",
            "Chemistry",
            "Biology",
            "ICT",
            "Religion",
            "Career Education",
          ],
          "Business Studies": [
            "Bangla 1st Paper",
            "Bangla 2nd Paper",
            "English 1st Paper",
            "English 2nd Paper",
            "General Mathematics",
            "Accounting",
            "Business Entrepreneurship",
            "Finance & Banking",
            "ICT",
            "Religion",
            "Career Education",
          ],
          Humanities: [
            "Bangla 1st Paper",
            "Bangla 2nd Paper",
            "English 1st Paper",
            "English 2nd Paper",
            "General Mathematics",
            "History",
            "Geography",
            "Civics & Citizenship",
            "ICT",
            "Religion",
            "Career Education",
          ],
        },
        "Class 10": {
          Science: [
            "Bangla 1st Paper",
            "Bangla 2nd Paper",
            "English 1st Paper",
            "English 2nd Paper",
            "General Mathematics",
            "Higher Mathematics",
            "Physics",
            "Chemistry",
            "Biology",
            "ICT",
            "Religion",
            "Career Education",
          ],
          "Business Studies": [
            "Bangla 1st Paper",
            "Bangla 2nd Paper",
            "English 1st Paper",
            "English 2nd Paper",
            "General Mathematics",
            "Accounting",
            "Business Entrepreneurship",
            "Finance & Banking",
            "ICT",
            "Religion",
            "Career Education",
          ],
          Humanities: [
            "Bangla 1st Paper",
            "Bangla 2nd Paper",
            "English 1st Paper",
            "English 2nd Paper",
            "General Mathematics",
            "History",
            "Geography",
            "Civics & Citizenship",
            "ICT",
            "Religion",
            "Career Education",
          ],
        },
      };

      const department =
        student.department ||
        (["Class 6", "Class 7", "Class 8"].includes(student.studentClass)
          ? "General"
          : "Science");
      const subjectNames =
        defaultSubjectsByClass[student.studentClass]?.[department] || [];

      const approved = await prisma.classSubjectRequest.findMany({
        where: {
          grade: student.studentClass,
          status: "APPROVED",
          section: student.studentSection || undefined,
        },
        select: {
          subject: true,
          teacherName: true,
          teacherEmail: true,
          section: true,
          subjectCode: true,
          room: true,
          schedule: true,
          time: true,
        },
      });

      const teacherMap = new Map(
        approved.map((item) => [item.subject.trim().toLowerCase(), item]),
      );

      const subjects = subjectNames.map((name, index) => {
        const matched = teacherMap.get(name.toLowerCase());

        return {
          id: `${student.studentClass}-${department}-${index}`,
          subject: name,
          subjectCode: matched?.subjectCode || null,
          grade: student.studentClass,
          section: matched?.section || student.studentSection || null,
          department,
          group: department,
          teacherName: matched?.teacherName || null,
          teacherEmail: matched?.teacherEmail || null,
          room: matched?.room || null,
          schedule: matched?.schedule || null,
          time: matched?.time || null,
          isTeacherAssigned: Boolean(matched?.teacherName),
        };
      });
      return res.json({
        success: true,
        count: subjects.length,
        subjects,
      });
    } catch (error: any) {
      console.error("Error fetching student subjects:", error);
      return res.status(500).json({
        success: false,
        error: error?.message || "Failed to fetch subjects",
      });
    }
  },
);

export default router;
