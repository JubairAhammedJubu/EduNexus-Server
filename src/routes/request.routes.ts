import { Router } from "express";
import { prisma } from "../lib/prisma.js";

const router = Router();

/**
 * GET /api/teacher/requests
 * Accepts query params: ?teacherEmail=... or ?status=...
 * Returns matching classSubjectRequest records sorted newest first.
 */
router.get("/teacher/requests", async (req, res) => {
  try {
    const { teacherEmail, status } = req.query;

    const whereClause: any = {};
    if (teacherEmail && typeof teacherEmail === "string") {
      whereClause.teacherEmail = teacherEmail;
    }
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
router.post("/teacher/requests", async (req, res) => {
  try {
    const {
      teacherEmail,
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

    if (!teacherEmail || !grade || !section || !subject) {
      return res.status(400).json({
        success: false,
        error: "Teacher email, grade, section, and subject are required fields.",
      });
    }

    const newRequest = await prisma.classSubjectRequest.create({
      data: {
        teacherEmail,
        teacherName: teacherName || "Teacher",
        grade,
        section,
        subject,
        subjectCode: subjectCode || `${subject.substring(0, 4).toUpperCase()}-${grade.replace(/[^0-9]/g, "") || "01"}${section.charAt(0)}`,
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
router.delete("/teacher/requests/:id", async (req, res) => {
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
router.patch("/admin/requests/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { status, adminFeedback } = req.body;

    if (!["APPROVED", "REJECTED", "PENDING"].includes(status)) {
      return res.status(400).json({
        success: false,
        error: "Invalid status value. Must be PENDING, APPROVED, or REJECTED.",
      });
    }

    const updated = await prisma.classSubjectRequest.update({
      where: { id },
      data: {
        status,
        ...(adminFeedback !== undefined ? { adminFeedback } : {}),
      },
    });

    return res.json({
      success: true,
      message: `Request status updated to ${status}`,
      request: updated,
    });
  } catch (error: any) {
    console.error("Error updating request status:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Failed to update request status",
    });
  }
});

export default router;
