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
      roll,
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
        ...(roll !== undefined && { roll: roll.trim() }),
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
 * GET /api/teacher/students
 * Fetches all users from the `users` collection where role is 'student'.
 * Supports filtering by class name (`studentClass`), searching by student name (`name`) or roll number (`roll`),
 * and pagination with 20 items per page by default.
 */
router.get("/teacher/students", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.max(1, parseInt(req.query.limit as string) || 20);
    const search = (req.query.search as string || "").trim();
    const studentClass = (req.query.studentClass as string || "").trim();

    const where: any = {
      role: "student",
    };

    if (studentClass && studentClass !== "All Classes") {
      where.studentClass = {
        contains: studentClass,
        mode: "insensitive",
      };
    }

    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { roll: { contains: search, mode: "insensitive" } },
      ];
    }

    const skip = (page - 1) * limit;

    const [totalCount, students] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
    ]);

    // Query distinct student classes from DB to populate dropdown options
    const distinctClasses = await prisma.user.findMany({
      where: { role: "student", studentClass: { not: null } },
      select: { studentClass: true },
      distinct: ["studentClass"],
    });

    const defaultClasses = ["All Classes", "Class 6", "Class 7", "Class 8", "Class 9", "Class 10"];
    const classSet = new Set<string>(defaultClasses);
    distinctClasses.forEach((c) => {
      if (c.studentClass && c.studentClass.trim()) {
        classSet.add(c.studentClass.trim());
      }
    });

    const totalPages = Math.ceil(totalCount / limit) || 1;

    return res.json({
      success: true,
      students,
      pagination: {
        total: totalCount,
        page,
        limit,
        totalPages,
      },
      classes: Array.from(classSet),
    });
  } catch (error: any) {
    console.error("Error fetching teacher students:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Failed to fetch student list",
    });
  }
});

export default router;

