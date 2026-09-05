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
 * Updates full profile information (name, image, phone, location, department,
 * bio, and the extended details collected in the post-registration step:
 * father/mother name, date of birth, address, blood group, and the
 * role-specific fields — schoolName/studentClass for students,
 * qualification for teachers) without requiring session cookies or
 * requireAuth middleware.
 */
router.put("/user/profile", async (req, res) => {
  try {
    const {
      email,
      userId,
      name,
      image,
      phone,
      location,
      department,
      bio,
      fatherName,
      motherName,
      dateOfBirth,
      address,
      bloodGroup,
      schoolName,
      studentClass,
      qualification,
    } = req.body;

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
        ...(fatherName !== undefined && { fatherName: fatherName.trim() }),
        ...(motherName !== undefined && { motherName: motherName.trim() }),
        ...(dateOfBirth !== undefined && {
          dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
        }),
        ...(address !== undefined && { address: address.trim() }),
        ...(bloodGroup !== undefined && { bloodGroup: bloodGroup.trim() }),
        ...(schoolName !== undefined && { schoolName: schoolName.trim() }),
        ...(studentClass !== undefined && {
          studentClass: studentClass.trim(),
        }),
        ...(qualification !== undefined && {
          qualification: qualification.trim(),
        }),
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

/**
 * GET /api/admin/user-2fa-status?email=...
 * Admin-only lookup so the reset-2FA UI can show whether a user currently
 * has an authenticator app enrolled before offering to reset it.
 */
router.get(
  "/admin/user-2fa-status",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    try {
      const email = (req.query.email as string | undefined)?.toLowerCase().trim();
      if (!email) {
        return res.status(400).json({ error: "Email is required." });
      }

      const user = await prisma.user.findUnique({
        where: { email },
        select: { id: true, name: true, email: true, twoFactorEnabled: true },
      });
      if (!user) {
        return res.status(404).json({ error: "No account found with that email." });
      }

      return res.json({
        user: {
          name: user.name,
          email: user.email,
          twoFactorEnabled: user.twoFactorEnabled,
        },
      });
    } catch (error: any) {
      console.error("Error looking up 2FA status:", error);
      return res
        .status(500)
        .json({ error: error?.message || "Failed to look up 2FA status." });
    }
  },
);

/**
 * POST /api/admin/reset-2fa
 * Admin-only recovery path for a user who lost their authenticator app /
 * QR code with no backup codes. We don't (and can't safely) hand back the
 * old QR — instead this wipes the user's stored TOTP secret and flips
 * `twoFactorEnabled` back to false. The existing login flow already shows
 * a fresh QR-setup screen the next time a user with 2FA disabled signs in
 * (see AuthPage.tsx), so no other change is needed — the user just logs
 * in with their email + password and re-enrolls a new authenticator.
 */
router.post(
  "/admin/reset-2fa",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    try {
      const email = (req.body?.email as string | undefined)?.toLowerCase().trim();
      if (!email) {
        return res.status(400).json({ error: "Email is required." });
      }

      const user = await prisma.user.findUnique({
        where: { email },
        select: { id: true, name: true, twoFactorEnabled: true },
      });
      if (!user) {
        return res.status(404).json({ error: "No account found with that email." });
      }

      await prisma.twoFactor.deleteMany({ where: { userId: user.id } });
      await prisma.user.update({
        where: { id: user.id },
        data: { twoFactorEnabled: false },
      });

      return res.json({
        success: true,
        message: `2FA reset for ${user.name}. They'll be prompted to set up a new authenticator on their next login.`,
      });
    } catch (error: any) {
      console.error("Error resetting 2FA:", error);
      return res
        .status(500)
        .json({ error: error?.message || "Failed to reset 2FA." });
    }
  },
);

export default router;
