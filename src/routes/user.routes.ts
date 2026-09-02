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

export default router;
