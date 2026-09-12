import { Router } from "express";
import multer from "multer";
import { requireAuth, requireRole } from "../middleware/session.js";
import { prisma } from "../lib/prisma.js";
import { getMaxImageSizeBytes, uploadImageToR2 } from "../lib/r2.js";

const router = Router();

// Multer Config for R2 Uploads
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

/**
 * GET /api/me
 * Returns profile of the currently logged-in user.
 */
router.get("/me", requireAuth, (req, res) => {
  return res.json({ success: true, user: req.user });
});

/**
 * GET /api/admin/overview
 * Admin diagnostic route.
 */
router.get("/admin/overview", requireAuth, requireRole("admin"), (req, res) => {
  return res.json({ message: `Welcome, admin ${req.user?.name ?? ""}` });
});

/**
 * POST /api/user/profile/image
 * Uploads an image to Cloudflare R2 and updates profile image URL.
 */
router.post(
  "/user/profile/image",
  requireAuth,
  handleImageUpload,
  async (req, res) => {
    try {
      const userId = req.user?.id;
      const files = req.files as
        | { [fieldname: string]: Express.Multer.File[] }
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
        user,
      });
    } catch (error: any) {
      console.error("Error uploading profile image:", error);
      return res.status(500).json({
        success: false,
        error: error?.message || "Failed to upload profile image",
      });
    }
  }
);

/**
 * PUT /api/user/profile
 * Updates user profile details.
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
    } = req.body;

    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
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
      success: false,
      error: error?.message || "Failed to update user profile information",
    });
  }
});

/**
 * GET /api/teacher/students
 * Fetches paginated & filtered list of students for teachers and admins.
 */
router.get(
  "/teacher/students",
  requireAuth,
  requireRole("teacher", "admin"),
  async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.max(1, parseInt(req.query.limit as string) || 20);
      const search = ((req.query.search as string) || "").trim();
      const studentClass = ((req.query.studentClass as string) || "").trim();

      const where: any = { role: "student" };

      if (studentClass && studentClass !== "All Classes") {
        where.studentClass = {
          contains: studentClass,
          mode: "insensitive",
        };
      }

      if (search) {
        where.OR = [
          { name: { contains: search, mode: "insensitive" } },
          { email: { contains: search, mode: "insensitive" } },
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
          orderBy: { name: "asc" },
        }),
      ]);

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
  }
);

/**
 * GET /api/admin/user-2fa-status?email=...
 * Admin lookup for user authenticator app status.
 */
router.get(
  "/admin/user-2fa-status",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    try {
      const email = (req.query.email as string | undefined)
        ?.toLowerCase()
        .trim();
      if (!email) {
        return res.status(400).json({ error: "Email is required." });
      }

      const user = await prisma.user.findUnique({
        where: { email },
        select: { id: true, name: true, email: true, twoFactorEnabled: true },
      });

      if (!user) {
        return res
          .status(404)
          .json({ error: "No account found with that email." });
      }

      return res.json({
        success: true,
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
  }
);

/**
 * POST /api/admin/reset-2fa
 * Admin-only recovery to disable 2FA for a user.
 */
router.post(
  "/admin/reset-2fa",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    try {
      const email = (req.body?.email as string | undefined)
        ?.toLowerCase()
        .trim();
      if (!email) {
        return res.status(400).json({ error: "Email is required." });
      }

      const user = await prisma.user.findUnique({
        where: { email },
        select: { id: true, name: true, twoFactorEnabled: true },
      });

      if (!user) {
        return res
          .status(404)
          .json({ error: "No account found with that email." });
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
  }
);

export default router;