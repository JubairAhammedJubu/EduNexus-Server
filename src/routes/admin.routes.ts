import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/session.js";
import { prisma } from "../lib/prisma.js";
import { hashPassword } from "better-auth/crypto";

export const router = Router();
export const adminOnly = [requireAuth, requireRole("admin")] as const;

// ──────────────────────────────────────────────────────────────
// DASHBOARD STATS
// ──────────────────────────────────────────────────────────────

/**
 * GET /api/admin/stats
 * Returns aggregated counts for the admin dashboard:
 * totalUsers, totalStudents, totalTeachers, totalAdmins,
 * pendingUsers, lockedUsers, totalNotices, totalAssignments,
 * totalExams, totalResults, totalRequests, pendingRequests.
 */
router.get("/admin/stats", ...adminOnly, async (_req, res) => {
  try {
    const [
      totalStudents,
      totalTeachers,
      totalAdmins,
      pendingUsers,
      lockedUsers,
      totalNotices,
      totalAssignments,
      totalExams,
      totalResults,
      totalRequests,
      pendingRequests,
    ] = await Promise.all([
      prisma.user.count({ where: { role: "student" } }),
      prisma.user.count({ where: { role: "teacher" } }),
      prisma.user.count({ where: { role: "admin" } }),
      prisma.user.count({ where: { isApproved: false } }),
      prisma.user.count({
        where: { lockedUntil: { gt: new Date() } },
      }),
      prisma.notice.count(),
      prisma.assignment.count(),
      prisma.exam.count(),
      prisma.studentResult.count(),
      prisma.classSubjectRequest.count(),
      prisma.classSubjectRequest.count({ where: { status: "PENDING" } }),
    ]);

    const totalUsers = totalStudents + totalTeachers + totalAdmins;

    return res.json({
      success: true,
      stats: {
        totalUsers,
        totalStudents,
        totalTeachers,
        totalAdmins,
        pendingUsers,
        lockedUsers,
        totalNotices,
        totalAssignments,
        totalExams,
        totalResults,
        totalRequests,
        pendingRequests,
      },
    });
  } catch (error: any) {
    console.error("Error fetching admin stats:", error);
    return res
      .status(500)
      .json({ error: error?.message || "Failed to fetch stats." });
  }
});

// ──────────────────────────────────────────────────────────────
// USER MANAGEMENT
// ──────────────────────────────────────────────────────────────

/**
 * GET /api/admin/users
 * Paginated & filtered list of ALL users.
 * Query params:
 *   page, limit, search (name/email), role (student|teacher|admin|all),
 *   isApproved (true|false|all), isLocked (true|false|all)
 */
router.get("/admin/users", ...adminOnly, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.max(
      1,
      Math.min(100, parseInt(req.query.limit as string) || 20),
    );
    const search = ((req.query.search as string) || "").trim();
    const role = ((req.query.role as string) || "all").trim();
    const isApprovedParam = req.query.isApproved as string | undefined;
    const isLockedParam = req.query.isLocked as string | undefined;

    const where: any = {};

    // Role filter
    if (role && role !== "all") {
      where.role = role;
    }

    // Approval filter
    if (isApprovedParam === "true") where.isApproved = true;
    else if (isApprovedParam === "false") where.isApproved = false;

    // Locked filter — lockedUntil > now means still locked
    if (isLockedParam === "true") {
      where.lockedUntil = { gt: new Date() };
    } else if (isLockedParam === "false") {
      where.OR = [{ lockedUntil: null }, { lockedUntil: { lte: new Date() } }];
    }

    // Search by name or email
    if (search) {
      const searchCondition = [
        { name: { contains: search, mode: "insensitive" as const } },
        { email: { contains: search, mode: "insensitive" as const } },
      ];
      // Merge with existing OR (locked filter) if any
      if (where.OR) {
        where.AND = [{ OR: where.OR }, { OR: searchCondition }];
        delete where.OR;
      } else {
        where.OR = searchCondition;
      }
    }

    const skip = (page - 1) * limit;

    const [totalCount, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          image: true,
          phone: true,
          department: true,
          isApproved: true,
          twoFactorEnabled: true,
          failedLoginAttempts: true,
          lockedUntil: true,
          studentClass: true,
          studentSection: true,
          group: true,
          qualification: true,
          assignedSubject: true,
          assignedClass: true,
          availability: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    ]);

    const totalPages = Math.ceil(totalCount / limit) || 1;

    return res.json({
      success: true,
      users,
      pagination: { total: totalCount, page, limit, totalPages },
    });
  } catch (error: any) {
    console.error("Error fetching users:", error);
    return res
      .status(500)
      .json({ error: error?.message || "Failed to fetch users." });
  }
});

/**
 * GET /api/admin/teachers
 * Returns a simple list of all approved teachers (for dropdowns, etc.)
 */
router.get("/admin/teachers", ...adminOnly, async (_req, res) => {
  try {
    const teachers = await prisma.user.findMany({
      where: {
        role: "teacher",
        isApproved: true,
      },
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        department: true,
        qualification: true,
        assignedSubject: true,
        assignedClass: true,
        availability: true,
        createdAt: true,
      },
      orderBy: { name: "asc" },
    });

    return res.json({ success: true, teachers });
  } catch (error: any) {
    console.error("Error fetching teachers:", error);
    return res
      .status(500)
      .json({ error: error?.message || "Failed to fetch teachers." });
  }
});

/**
 * PATCH /api/admin/users/:id/role
 * Changes a user's role.
 * Body: { role: "student" | "teacher" | "admin" }
 * An admin cannot change their own role.
 */
router.patch("/admin/users/:id/role", ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    if (!["student", "teacher", "admin"].includes(role)) {
      return res.status(400).json({
        error: "Invalid role. Must be student, teacher, or admin.",
      });
    }

    // Prevent admin from changing their own role
    if (req.user?.id === id) {
      return res.status(403).json({
        error: "You cannot change your own role.",
      });
    }

    const user = await prisma.user.update({
      where: { id },
      data: { role },
      select: { id: true, name: true, email: true, role: true },
    });

    return res.json({
      success: true,
      message: `${user.name}'s role updated to ${role}.`,
      user,
    });
  } catch (error: any) {
    console.error("Error changing user role:", error);
    if (error?.code === "P2025") {
      return res.status(404).json({ error: "User not found." });
    }
    return res
      .status(500)
      .json({ error: error?.message || "Failed to change user role." });
  }
});

/**
 * POST /api/admin/users
 * Admin endpoint to create a new user (student or teacher) directly in the DB.
 */
router.post("/admin/users", ...adminOnly, async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      phone,
      role = "student",
      studentClass,
      studentSection,
      group,
      department,
      qualification,
      assignedSubject,
      assignedClass,
      isApproved = true,
      fatherName,
      motherName,
      dateOfBirth,
      address,
      bloodGroup,
      gender,
      guardianPhone,
      guardianRelation,
      sessionYear,
      roll,
      schoolName,
    } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: "Name and email are required." });
    }

    let cleanEmail = String(email).toLowerCase().trim();
    if (!cleanEmail.includes("@")) {
      const domain = role === "teacher" ? "@edunexus.tchr.com" : "@edunexus.std.com";
      cleanEmail = `${cleanEmail}${domain}`;
    }

    const existing = await prisma.user.findUnique({
      where: { email: cleanEmail },
    });

    if (existing) {
      return res.status(400).json({ error: "User with this email already exists." });
    }

    // Determine password (default to student1234 / teacher1234 if not provided)
    const rawPassword = password
      ? String(password).trim()
      : role === "teacher"
      ? "teacher1234"
      : "student1234";

    if (rawPassword.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters long." });
    }

    const passwordHash = await hashPassword(rawPassword);

    // Auto-calculate roll number if student & not explicitly provided
    let assignedRoll = roll ? String(roll).trim() : null;
    if (role === "student" && !assignedRoll && studentClass && studentSection) {
      const cleanClass = String(studentClass).trim();
      const cleanSection = String(studentSection).trim();
      const groupFilter = group ? { group: String(group).trim() } : {};

      const existingStudents = await prisma.user.findMany({
        where: {
          role: { in: ["student", "STUDENT"] },
          studentClass: cleanClass,
          studentSection: cleanSection,
          ...groupFilter,
        },
        select: { roll: true },
      });

      let maxRoll = 0;
      for (const s of existingStudents) {
        if (s.roll) {
          const num = parseInt(s.roll.replace(/\D/g, ""), 10);
          if (!isNaN(num) && num > maxRoll) {
            maxRoll = num;
          }
        }
      }
      assignedRoll = (maxRoll + 1).toString();
    }

    let parsedDob: Date | null = null;
    if (dateOfBirth) {
      const parsed = new Date(dateOfBirth);
      if (!isNaN(parsed.getTime())) {
        parsedDob = parsed;
      }
    }

    const user = await prisma.user.create({
      data: {
        name: String(name).trim(),
        email: cleanEmail,
        phone: phone ? String(phone).trim() : null,
        role: String(role).trim(),
        studentClass: studentClass ? String(studentClass).trim() : null,
        studentSection: studentSection ? String(studentSection).trim() : null,
        group: group ? String(group).trim() : null,
        department: department ? String(department).trim() : null,
        qualification: qualification ? String(qualification).trim() : null,
        assignedSubject: assignedSubject ? String(assignedSubject).trim() : null,
        assignedClass: assignedClass ? String(assignedClass).trim() : null,
        isApproved: Boolean(isApproved),
        fatherName: fatherName ? String(fatherName).trim() : null,
        motherName: motherName ? String(motherName).trim() : null,
        dateOfBirth: parsedDob,
        address: address ? String(address).trim() : null,
        bloodGroup: bloodGroup ? String(bloodGroup).trim() : null,
        gender: gender ? String(gender).trim() : null,
        guardianPhone: guardianPhone ? String(guardianPhone).trim() : null,
        guardianRelation: guardianRelation ? String(guardianRelation).trim() : null,
        sessionYear: sessionYear ? String(sessionYear).trim() : new Date().getFullYear().toString(),
        roll: assignedRoll,
        schoolName: schoolName ? String(schoolName).trim() : null,
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        phone: true,
        department: true,
        qualification: true,
        studentClass: true,
        studentSection: true,
        group: true,
        isApproved: true,
        assignedSubject: true,
        assignedClass: true,
        availability: true,
        fatherName: true,
        motherName: true,
        dateOfBirth: true,
        address: true,
        bloodGroup: true,
        gender: true,
        guardianPhone: true,
        guardianRelation: true,
        sessionYear: true,
        roll: true,
        schoolName: true,
        createdAt: true,
      },
    });

    // Create Better Auth Account credential record so user can log in with password
    await prisma.account.create({
      data: {
        userId: user.id,
        accountId: user.id,
        providerId: "credential",
        password: passwordHash,
      },
    });

    return res.status(201).json({
      success: true,
      message: `Account created for ${user.name}!`,
      user,
      temporaryPassword: rawPassword,
    });
  } catch (error: any) {
    console.error("Error creating user:", error);
    return res
      .status(500)
      .json({ error: error?.message || "Failed to create user account." });
  }
});

/**
 * PATCH /api/admin/users/:id
 * Updates general user profile info (name, phone, studentClass, studentSection, department, qualification, isApproved, availability).
 */
router.patch("/admin/users/:id", ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      phone,
      department,
      qualification,
      studentClass,
      studentSection,
      group,
      assignedSubject,
      assignedClass,
      availability,
      isApproved,
    } = req.body;

    const data: any = {};
    if (name !== undefined) data.name = name;
    if (phone !== undefined) data.phone = phone;
    if (department !== undefined) data.department = department;
    if (qualification !== undefined) data.qualification = qualification;
    if (studentClass !== undefined) data.studentClass = studentClass;
    if (studentSection !== undefined) data.studentSection = studentSection;
    if (group !== undefined) data.group = group;
    if (isApproved !== undefined) data.isApproved = Boolean(isApproved);
    if (assignedSubject !== undefined) data.assignedSubject = assignedSubject;
    if (assignedClass !== undefined) data.assignedClass = assignedClass;
    if (availability !== undefined) data.availability = availability;

    const user = await prisma.user.update({
      where: { id },
      data,
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        phone: true,
        department: true,
        qualification: true,
        studentClass: true,
        studentSection: true,
        group: true,
        isApproved: true,
        assignedSubject: true,
        assignedClass: true,
        availability: true,
      },
    });

    return res.json({
      success: true,
      message: `Profile updated for ${user.name}.`,
      user,
    });
  } catch (error: any) {
    console.error("Error updating user profile:", error);
    if (error?.code === "P2025") {
      return res.status(404).json({ error: "User not found." });
    }
    return res
      .status(500)
      .json({ error: error?.message || "Failed to update user profile." });
  }
});

/**
 * PATCH /api/admin/users/:id/disapprove
 * Revokes an already-approved user's access (sets isApproved = false).
 * Admin cannot disapprove themselves.
 */
router.patch("/admin/users/:id/disapprove", ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;

    if (req.user?.id === id) {
      return res.status(403).json({
        error: "You cannot revoke your own access.",
      });
    }

    const user = await prisma.user.update({
      where: { id },
      data: { isApproved: false },
      select: { id: true, name: true, email: true },
    });

    return res.json({
      success: true,
      message: `${user.name}'s access has been revoked.`,
      user,
    });
  } catch (error: any) {
    console.error("Error disapproving user:", error);
    if (error?.code === "P2025") {
      return res.status(404).json({ error: "User not found." });
    }
    return res
      .status(500)
      .json({ error: error?.message || "Failed to revoke user access." });
  }
});

/**
 * PATCH /api/admin/users/:id/unlock
 * Clears login lockout (resets failedLoginAttempts & lockedUntil).
 */
router.patch("/admin/users/:id/unlock", ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;

    const user = await prisma.user.update({
      where: { id },
      data: { failedLoginAttempts: 0, lockedUntil: null },
      select: { id: true, name: true, email: true },
    });

    return res.json({
      success: true,
      message: `${user.name}'s account has been unlocked.`,
      user,
    });
  } catch (error: any) {
    console.error("Error unlocking user:", error);
    if (error?.code === "P2025") {
      return res.status(404).json({ error: "User not found." });
    }
    return res
      .status(500)
      .json({ error: error?.message || "Failed to unlock account." });
  }
});

/**
 * DELETE /api/admin/users/:id
 * Permanently deletes a user and all their related data (cascade in Prisma).
 * Admin cannot delete themselves.
 */
router.delete("/admin/users/:id", ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;

    if (req.user?.id === id) {
      return res.status(403).json({
        error: "You cannot delete your own account.",
      });
    }

    const existing = await prisma.user.findUnique({
      where: { id },
      select: { name: true, email: true },
    });

    if (!existing) {
      return res.status(404).json({ error: "User not found." });
    }

    const targetEmail = (existing.email || "").toLowerCase().trim();
    if (
      targetEmail === "demostudent@edunexus.std.com" ||
      targetEmail === "demoteacher@edunexus.tchr.com" ||
      targetEmail.includes("demostudent") ||
      targetEmail.includes("demoteacher")
    ) {
      return res.status(403).json({
        error: "Demo accounts are protected and cannot be deleted.",
      });
    }

    await prisma.user.delete({ where: { id } });

    return res.json({
      success: true,
      message: `User "${existing.name}" (${existing.email}) has been deleted.`,
    });
  } catch (error: any) {
    console.error("Error deleting user:", error);
    return res
      .status(500)
      .json({ error: error?.message || "Failed to delete user." });
  }
});

// ──────────────────────────────────────────────────────────────
// PDF RECEIPT GENERATION ENDPOINT
// ──────────────────────────────────────────────────────────────

/**
 * POST /api/admin/receipts/generate-pdf
 * Generates an official downloadable/printable PDF fee receipt.
 */
router.post("/admin/receipts/generate-pdf", ...adminOnly, async (req, res) => {
  try {
    const {
      invoiceId = "INV-2026-001",
      studentName = "Student Name",
      studentClass = "Grade 10",
      feeType = "Tuition Fee",
      amount = "$450",
      paymentMethod = "Online Gateway",
      date = new Date().toLocaleDateString(),
      status = "Paid",
    } = req.body;

    const receiptHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Receipt_${invoiceId}</title>
          <style>
            body { font-family: 'Segoe UI', Arial, sans-serif; padding: 40px; color: #0f172a; background: #f8fafc; margin: 0; }
            .card { background: #ffffff; border: 2px solid #e2e8f0; border-radius: 24px; padding: 36px; max-width: 620px; margin: 0 auto; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.05); }
            .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px dashed #cbd5e1; padding-bottom: 24px; margin-bottom: 24px; }
            .brand { font-size: 26px; font-weight: 900; color: #059669; letter-spacing: -0.5px; }
            .sub { font-size: 13px; color: #64748b; margin-top: 4px; font-weight: 500; }
            .stamp { background: #dcfce7; color: #15803d; border: 1.5px solid #86efac; padding: 8px 18px; border-radius: 99px; font-weight: 800; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; }
            .rows { margin: 24px 0; font-size: 14px; }
            .row { display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #f1f5f9; }
            .label { color: #64748b; font-weight: 600; }
            .value { font-weight: 700; color: #0f172a; }
            .total { display: flex; justify-content: space-between; padding: 18px 0; margin-top: 18px; border-top: 2.5px solid #0f172a; font-size: 20px; font-weight: 900; }
            .footer { text-align: center; font-size: 12px; color: #94a3b8; margin-top: 32px; border-top: 1px solid #f1f5f9; pt: 16px; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="header">
              <div>
                <div class="brand">🎓 EduNexus Smart Campus</div>
                <div class="sub">Official Payment Receipt &amp; Financial Invoice</div>
              </div>
              <div class="stamp">${status}</div>
            </div>
            <div class="rows">
              <div class="row"><span class="label">Invoice ID:</span><span class="value">${invoiceId}</span></div>
              <div class="row"><span class="label">Student Name:</span><span class="value">${studentName}</span></div>
              <div class="row"><span class="label">Class / Grade:</span><span class="value">${studentClass}</span></div>
              <div class="row"><span class="label">Fee Particulars:</span><span class="value">${feeType}</span></div>
              <div class="row"><span class="label">Payment Mode:</span><span class="value">${paymentMethod}</span></div>
              <div class="row"><span class="label">Payment Date:</span><span class="value">${date}</span></div>
              <div class="total"><span>Total Amount Paid:</span><span style="color: #059669;">${amount}</span></div>
            </div>
            <div class="footer">
              <p>Verified Computer Generated Receipt • EduNexus Finance Directorate © 2026</p>
            </div>
          </div>
          <script>
            window.onload = function() {
              window.print();
            };
          </script>
        </body>
      </html>
    `;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(receiptHtml);
  } catch (error: any) {
    console.error("Error generating receipt PDF:", error);
    return res.status(500).json({ error: "Failed to generate receipt PDF." });
  }
});

export default router;
