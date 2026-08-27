import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/session.js";
import { prisma } from "../lib/prisma.js";

const router = Router();

// GET /api/me — any logged-in user (admin, teacher, or student).
router.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// GET /api/admin/overview — admin-only example.
router.get("/admin/overview", requireAuth, requireRole("admin"), (req, res) => {
  res.json({ message: `Welcome, admin ${req.user?.name ?? ""}` });
});

/**
 * PUT /api/user/profile
 * Updates full profile information (name, image, phone, location, department, bio)
 * without requiring session cookies or requireAuth middleware.
 */
router.put("/user/profile", async (req, res) => {
  try {
    const { email, userId, name, image, phone, location, department, bio } = req.body;

    const targetUserId = userId || req.user?.id;

    if (!targetUserId && !email) {
      return res.status(400).json({
        error: "User email or ID is required to update profile.",
      });
    }

    const where = targetUserId
      ? { id: targetUserId }
      : { email: email.toLowerCase().trim() };

    const updatedUser = await prisma.user.update({
      where,
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(image !== undefined && { image: image.trim() }),
        ...(phone !== undefined && { phone: phone.trim() }),
        ...(location !== undefined && { location: location.trim() }),
        ...(department !== undefined && { department: department.trim() }),
        ...(bio !== undefined && { bio: bio.trim() }),
      },
    });

    return res.json({
      success: true,
      message: "Profile information updated successfully",
      user: updatedUser,
    });
  } catch (error: any) {
    console.error("Error updating profile:", error);
    return res.status(500).json({
      error: error?.message || "Failed to update user profile information",
    });
  }
});

export default router;
