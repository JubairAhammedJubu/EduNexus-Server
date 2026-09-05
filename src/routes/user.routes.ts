import { Router } from "express";
import multer from "multer";
import { requireAuth, requireRole } from "../middleware/session.js";
import { prisma } from "../lib/prisma.js";
import { getMaxImageSizeBytes, uploadImageToR2 } from "../lib/r2.js";

const router = Router();
const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: getMaxImageSizeBytes() },
  fileFilter: (_req, file, callback) => {
    callback(
      null,
      ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(
        file.mimetype,
      ),
    );
  },
});

function handleImageUpload(req: any, res: any, next: any) {
  uploadImage.fields([
    { name: "file", maxCount: 1 },
    { name: "image", maxCount: 1 },
  ])(req, res, (error: any) => {
    if (error) {
      return res.status(400).json({
        success: false,
        error:
          error.code === "LIMIT_FILE_SIZE"
            ? "Image must be 5 MB or smaller."
            : "A valid image is required in the 'file' field.",
      });
    }

    next();
  });
}

// GET /api/me — any logged-in user (admin, teacher, or student).
router.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// GET /api/admin/overview — admin-only example.
router.get("/admin/overview", requireAuth, requireRole("admin"), (req, res) => {
  res.json({ message: `Welcome, admin ${req.user?.name ?? ""}` });
});

/**
 * POST /api/user/profile/image
 * Uploads an image to Cloudflare R2 and saves its public URL to the profile.
 */
router.post(
  "/user/profile/image",
  requireAuth,
  handleImageUpload,
  async (req, res) => {
    try {
      const userId = req.user?.id;
      const files = req.files as
        | {
            [fieldname: string]: Express.Multer.File[];
          }
        | undefined;
      const file = files?.file?.[0] ?? files?.image?.[0];

      if (!userId) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      if (!file) {
        return res.status(400).json({
          success: false,
          error: "A valid image is required in the 'file' field.",
        });
      }

      const imageUrl = await uploadImageToR2(file, userId);
      const user = await prisma.user.update({
        where: { id: userId },
        data: { image: imageUrl },
      });

      return res.json({
        success: true,
        message: "Profile image uploaded successfully.",
        imageUrl,
        fileUrl: imageUrl,
        image: imageUrl,
        user,
      });
    } catch (error: any) {
      console.error("Error uploading profile image:", error);
      return res.status(500).json({
        success: false,
        error: error?.message || "Failed to upload profile image",
      });
    }
  },
);

// GET /api/students - authenticated users receive student records only.
router.get("/students", async (_req, res) => {
  try {
    const students = await prisma.user.findMany({
      where: { role: "student" },
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        phone: true,
        location: true,
        department: true,
        bio: true,
        studentClass: true,
        studentSection: true,
        schoolName: true,
        createdAt: true,
      },
      orderBy: { name: "asc" },
    });

    return res.json({
      success: true,
      count: students.length,
      students,
    });
  } catch (error: any) {
    console.error("Error fetching students:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Failed to fetch students",
    });
  }
});

/**
 * PUT /api/user/profile
 * Updates full profile information (name, image, phone, location, department,
 * bio, and the extended details collected in the post-registration step:
 * father/mother name, date of birth, address, blood group, and the
 * role-specific fields — schoolName/studentClass for students,
 * qualification for teachers).
 */
router.put("/user/profile", requireAuth, async (req, res) => {
  try {
    const {
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
      studentSection,
      qualification,
      roll,
    } = req.body;

    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
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
        ...(studentSection !== undefined && {
          studentSection: studentSection.trim(),
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
    const search = ((req.query.search as string) || "").trim();
    const studentClass = ((req.query.studentClass as string) || "").trim();

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

    const defaultClasses = [
      "All Classes",
      "Class 6",
      "Class 7",
      "Class 8",
      "Class 9",
      "Class 10",
    ];
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
