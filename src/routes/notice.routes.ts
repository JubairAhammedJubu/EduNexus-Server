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
 * Accepts: teacherName, publishedBy, authorEmail, title, detail, category, isPinned, createdAt
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
      detail,
      category,
      isPinned,
      createdAt,
    } = req.body;

    if (!title?.trim() || !detail?.trim()) {
      return res.status(400).json({
        error: "Title and notice detail are required.",
      });
    }

    const nameOfTeacher =
      teacherName?.trim() || publishedBy?.trim() || user?.name || user?.email || "Teacher";

    const emailOfAuthor = user?.email || authorEmail?.trim() || undefined;

    const newNotice = await prisma.notice.create({
      data: {
        title: title.trim(),
        detail: detail.trim(),
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

/**
 * PUT /api/notices/:id
 * Updates an existing notice.
 * Security: Admins can update any notice. Teachers can update only their own notices.
 */
router.put("/notices/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Session extraction
    const sessionResult = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    const user = sessionResult?.user;

    if (!user) {
      return res.status(401).json({ error: "Unauthorized: Authentication required." });
    }

    const existingNotice = await prisma.notice.findUnique({
      where: { id },
    });

    if (!existingNotice) {
      return res.status(404).json({ error: "Notice not found." });
    }

    // Ownership & Role Verification
    const isAdmin = (user as { role?: string }).role === "admin";
    const isAuthor = Boolean(
      (user.email && existingNotice.authorEmail === user.email) ||
      (user.name && existingNotice.teacherName === user.name)
    );

    if (!isAdmin && !isAuthor) {
      return res.status(403).json({
        error: "Forbidden: You do not have permission to edit this notice.",
      });
    }

    const {
      title,
      detail,
      category,
      isPinned,
      teacherName,
    } = req.body;

    const updatedNotice = await prisma.notice.update({
      where: { id },
      data: {
        ...(title !== undefined && { title: title.trim() }),
        ...(detail !== undefined && { detail: detail.trim() }),
        ...(category !== undefined && { category: category.trim() }),
        ...(isPinned !== undefined && { isPinned: Boolean(isPinned) }),
        ...(teacherName !== undefined && { teacherName: teacherName.trim() }),
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

    return res.json({
      success: true,
      message: "Notice updated successfully",
      notice: updatedNotice,
    });
  } catch (error: any) {
    console.error("Error updating notice:", error);
    return res.status(500).json({
      error: error?.message || "Failed to update notice",
    });
  }
});

/**
 * DELETE /api/notices/:id
 * Deletes a notice.
 * Security: Admins can delete any notice. Teachers can delete only their own notices.
 */
router.delete("/notices/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Session extraction
    const sessionResult = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    const user = sessionResult?.user;

    if (!user) {
      return res.status(401).json({ error: "Unauthorized: Authentication required." });
    }

    const existingNotice = await prisma.notice.findUnique({
      where: { id },
    });

    if (!existingNotice) {
      return res.status(404).json({ error: "Notice not found." });
    }

    // Ownership & Role Verification
    const isAdmin = (user as { role?: string }).role === "admin";
    const isAuthor = Boolean(
      (user.email && existingNotice.authorEmail === user.email) ||
      (user.name && existingNotice.teacherName === user.name)
    );

    if (!isAdmin && !isAuthor) {
      return res.status(403).json({
        error: "Forbidden: You do not have permission to delete this notice.",
      });
    }

    await prisma.notice.delete({
      where: { id },
    });

    return res.json({
      success: true,
      message: "Notice deleted successfully",
      id,
    });
  } catch (error: any) {
    console.error("Error deleting notice:", error);
    return res.status(500).json({
      error: error?.message || "Failed to delete notice",
    });
  }
});

export default router;
