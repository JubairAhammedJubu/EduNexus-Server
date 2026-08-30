import { Router } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../lib/auth.js";
import { prisma } from "../lib/prisma.js";

const router = Router();

/**
 * GET /api/notices
 * Returns all notices ordered by isPinned (true first) and createdAt (newest first).
 * Public endpoint so all dashboards & public notice board can display notices.
 */
router.get("/notices", async (_req, res) => {
  try {
    const notices = await prisma.notice.findMany({
      orderBy: [
        { isPinned: "desc" },
        { createdAt: "desc" },
      ],
      include: {
        author: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
            role: true,
          },
        },
      },
    });

    return res.json({
      success: true,
      notices,
    });
  } catch (error: any) {
    console.error("Error fetching notices:", error);
    return res.status(500).json({
      error: error?.message || "Failed to fetch notices",
    });
  }
});

/**
 * POST /api/notices
 * Creates a new notice in the database.
 * Accepts: publishedBy, title, description, detail, category, isPinned, createdAt
 */
router.post("/notices", async (req, res) => {
  try {
    // Attempt session extraction
    const sessionResult = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });

    const user = sessionResult?.user;

    const {
      teacherName,
      publishedBy,
      authorEmail,
      title,
      description,
      detail,
      category,
      isPinned,
      createdAt,
    } = req.body;

    const noticeDetail = (detail || description || "").trim();

    if (!title?.trim() || !noticeDetail) {
      return res.status(400).json({
        error: "Title and notice detail/description are required.",
      });
    }

    const nameOfTeacher =
      teacherName?.trim() || publishedBy?.trim() || user?.name || user?.email || "Teacher";

    const emailOfAuthor = user?.email || authorEmail?.trim() || undefined;

    const newNotice = await prisma.notice.create({
      data: {
        title: title.trim(),
        description: (description || noticeDetail).trim(),
        detail: noticeDetail,
        category: category?.trim() || "General",
        isPinned: Boolean(isPinned),
        teacherName: nameOfTeacher,
        authorEmail: emailOfAuthor,
        ...(createdAt ? { createdAt: new Date(createdAt) } : {}),
      },


      include: {
        author: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
            role: true,
          },
        },
      },
    });

    return res.status(201).json({
      success: true,
      message: "Notice published successfully",
      notice: newNotice,
    });
  } catch (error: any) {
    console.error("Error publishing notice:", error);
    return res.status(500).json({
      error: error?.message || "Failed to publish notice",
    });
  }
});

export default router;
