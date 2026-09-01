import { Router } from "express";
import { prisma } from "../lib/prisma.js";

const router = Router();

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

export default router;