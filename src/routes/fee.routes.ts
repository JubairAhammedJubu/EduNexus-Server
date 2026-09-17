import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole } from "../middleware/session.js";
import type { FeeType, PaymentMethod } from "@prisma/client";

import multer from "multer";
import { uploadBufferToR2 } from "../lib/r2.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype));
  },
});

function handleScreenshot(req: any, res: any, next: any) {
  upload.single("screenshot")(req, res, (err: any) => {
    if (err) {
      return res.status(400).json({
        success: false,
        error:
          err.code === "LIMIT_FILE_SIZE"
            ? "Screenshot must be 5 MB or smaller"
            : "Invalid upload",
      });
    }
    next();
  });
}

const router = Router();
const adminOnly = [requireAuth, requireRole("admin")];
function examKey(feeType: FeeType, examId?: string | null) {
  if (feeType === "EXAM") return examId || null;
  return "none";
}
function generateReceiptNo() {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `RCPT-${stamp}-${rand}`;
}

function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/** UI: bkash/nagad/... → Prisma method + gateway */
function resolvePayment(raw: string): {
  method: PaymentMethod;
  gateway: string | null;
} {
  const v = String(raw || "")
    .trim()
    .toLowerCase();
  if (v === "cash") return { method: "CASH", gateway: null };
  if (v === "bank") return { method: "BANK", gateway: null };

  const map: Record<string, string> = {
    bkash: "bKash",
    nagad: "Nagad",
    rocket: "Rocket",
    upay: "Upay",
    mobile_banking: "bKash",
  };
  if (map[v]) return { method: "MOBILE_BANKING", gateway: map[v] };
  throw new Error("Invalid payment method");
}

function parseFeeType(raw: unknown): FeeType | null {
  const v = String(raw || "")
    .trim()
    .toUpperCase();
  if (["MONTHLY", "EXAM", "REGISTRATION", "OTHER"].includes(v)) {
    return v as FeeType;
  }
  return null;
}
async function upsertStructure(input: {
  studentClass: string;
  feeType: FeeType;
  amount: number;
  sessionYear: string;
  examId?: string | null;
}) {
  const examId = examKey(input.feeType, input.examId);

  const existing = await prisma.feeStructure.findFirst({
    where: {
      studentClass: input.studentClass,
      feeType: input.feeType,
      sessionYear: input.sessionYear,
      examId,
    },
  });

  if (existing) {
    return prisma.feeStructure.update({
      where: { id: existing.id },
      data: { amount: input.amount },
    });
  }

  try {
    return await prisma.feeStructure.create({
      data: {
        studentClass: input.studentClass,
        feeType: input.feeType,
        amount: input.amount,
        sessionYear: input.sessionYear,
        examId,
      },
    });
  } catch (err: any) {
    // unique race → update existing
    const again = await prisma.feeStructure.findFirst({
      where: {
        studentClass: input.studentClass,
        feeType: input.feeType,
        sessionYear: input.sessionYear,
        examId,
      },
    });
    if (again) {
      return prisma.feeStructure.update({
        where: { id: again.id },
        data: { amount: input.amount },
      });
    }
    throw err;
  }
}

// ── Structure ─────────────────────────────────────────────────────────────

/** POST /api/admin/fees/structure */
router.post("/admin/fees/structure", ...adminOnly, async (req, res) => {
  try {
    const feeType = parseFeeType(req.body.feeType) || "MONTHLY";
    const studentClass = String(req.body.studentClass || "").trim();
    const sessionYear = String(
      req.body.sessionYear || new Date().getFullYear(),
    ).trim();
    const amount = Number(req.body.amount);

    if (!studentClass || !Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({
        success: false,
        error: "studentClass and valid amount are required",
      });
    }

    if (feeType === "EXAM" && !req.body.examId) {
      return res.status(400).json({
        success: false,
        error: "examId required for EXAM fee type",
      });
    }

    const structure = await upsertStructure({
      studentClass,
      feeType,
      amount,
      sessionYear,
      examId: req.body.examId,
    });

    return res.json({ success: true, structure });
  } catch (err: any) {
    console.error("[fees] structure save:", err);
    return res.status(500).json({
      success: false,
      error: err?.message || "Failed to save structure",
    });
  }
});

/** GET /api/admin/fees/structure */
router.get("/admin/fees/structure", ...adminOnly, async (req, res) => {
  try {
    const sessionYear = (req.query.sessionYear as string) || undefined;
    const structures = await prisma.feeStructure.findMany({
      where: sessionYear ? { sessionYear } : {},
      orderBy: [{ studentClass: "asc" }, { feeType: "asc" }],
    });
    return res.json({ success: true, structures });
  } catch (err: any) {
    console.error("[fees] structure list:", err);
    return res.status(500).json({
      success: false,
      error: err?.message || "Failed to list structures",
    });
  }
});

/** POST /api/admin/fees/structure/seed-monthly */
router.post(
  "/admin/fees/structure/seed-monthly",
  ...adminOnly,
  async (req, res) => {
    try {
      const sessionYear = String(
        req.body.sessionYear || new Date().getFullYear(),
      );
      const fees: Record<string, number> = {
        "Class 6": 1200,
        "Class 7": 1300,
        "Class 8": 1400,
        "Class 9": 1500,
        "Class 10": 1600,
      };

      const structures = [];
      for (const [studentClass, amount] of Object.entries(fees)) {
        const row = await upsertStructure({
          studentClass,
          feeType: "MONTHLY",
          amount,
          sessionYear,
        });
        structures.push(row);
      }

      return res.json({ success: true, structures });
    } catch (err: any) {
      console.error("[fees] seed:", err);
      return res.status(500).json({
        success: false,
        error: err?.message || "Seed failed",
      });
    }
  },
);

/** DELETE /api/admin/fees/structure/:id */
router.delete("/admin/fees/structure/:id", ...adminOnly, async (req, res) => {
  try {
    await prisma.feeStructure.delete({ where: { id: req.params.id } });
    return res.json({ success: true, message: "Deleted" });
  } catch (err: any) {
    console.error("[fees] delete structure:", err);
    return res.status(500).json({
      success: false,
      error: err?.message || "Delete failed",
    });
  }
});

// ── Record payment (office) ───────────────────────────────────────────────

/** POST /api/admin/fees/payments */
router.post("/admin/fees/payments", ...adminOnly, async (req, res) => {
  try {
    const feeType = parseFeeType(req.body.feeType);
    const studentId = String(req.body.studentId || "").trim();
    const trx = String(req.body.transactionRef || "").trim();
    const year = String(
      req.body.sessionYear || new Date().getFullYear(),
    ).trim();
    const month = req.body.month
      ? String(req.body.month).trim()
      : currentMonthKey();

    if (!studentId || !feeType || !req.body.method || !trx) {
      return res.status(400).json({
        success: false,
        error: "studentId, feeType, method, and transactionRef are required",
      });
    }
    if (trx.length < 5) {
      return res.status(400).json({
        success: false,
        error: "Valid TrxID is required",
      });
    }

    let resolved: { method: PaymentMethod; gateway: string | null };
    try {
      resolved = resolvePayment(req.body.method);
    } catch {
      return res.status(400).json({
        success: false,
        error: "Invalid payment method",
      });
    }

    const student = await prisma.user.findUnique({ where: { id: studentId } });
    if (!student || student.role !== "student") {
      return res.status(404).json({
        success: false,
        error: "Student not found",
      });
    }

    const structure = await prisma.feeStructure.findFirst({
      where: {
        studentClass: student.studentClass ?? "",
        feeType,
        sessionYear: year,
        examId: examKey(feeType, req.body.examId),
      },
    });
    if (!structure) {
      return res.status(400).json({
        success: false,
        error:
          "Fee structure not set for this class / fee type. Seed structure first.",
      });
    }

    const duplicate = await prisma.feePayment.findFirst({
      where: {
        studentId,
        feeType,
        sessionYear: year,
        status: { in: ["APPROVED", "PENDING"] },
        ...(feeType === "MONTHLY" ? { month } : {}),
      },
    });
    if (duplicate) {
      return res.status(409).json({
        success: false,
        error: "Payment already exists for this period",
        existingReceiptNo: duplicate.receiptNo,
      });
    }

    const payment = await prisma.feePayment.create({
      data: {
        studentId,
        studentEmail: student.email,
        studentName: student.name,
        studentClass: student.studentClass ?? "",
        feeType,
        amount: structure.amount,
        method: resolved.method,
        gateway: resolved.gateway,
        transactionRef: trx,
        sessionYear: year,
        month: feeType === "MONTHLY" ? month : null,
        examId: feeType === "EXAM" ? String(req.body.examId) : null,
        note: req.body.note ? String(req.body.note) : null,
        receiptNo: generateReceiptNo(),
        recordedByAdminEmail: req.user!.email,
        status: "APPROVED",
        submittedByStudent: false,
      },
    });

    return res.status(201).json({ success: true, payment });
  } catch (err: any) {
    console.error("[fees] record payment:", err);
    return res.status(500).json({
      success: false,
      error: err?.message || "Failed to record payment",
    });
  }
});

// ── Claims ────────────────────────────────────────────────────────────────

/** GET /api/admin/fees/claims?status=PENDING */
router.get("/admin/fees/claims", ...adminOnly, async (req, res) => {
  try {
    const status = (req.query.status as string) || "PENDING";
    const claims = await prisma.feePayment.findMany({
      where: {
        submittedByStudent: true,
        status: status as any,
      },
      orderBy: { paidAt: "desc" },
    });

    // Strip sensitive fields before sending to admin UI
    const safe = claims.map(
      ({ transactionRef, screenshotUrl, ...rest }) => rest,
    );

    return res.json({ success: true, claims: safe });
  } catch (err: any) {
    console.error("[fees] claims:", err);
    return res.status(500).json({
      success: false,
      error: err?.message || "Failed to fetch claims",
    });
  }
});

/** PATCH /api/admin/fees/claims/:id/approve */
/**
 * PATCH /api/admin/fees/claims/:id/verify
 * Body: { transactionRef: string }
 * Admin must enter the same TrxID the student used.
 * TrxID is never returned in the claims list (stripped).
 */
router.patch(
  "/admin/fees/claims/:id/verify",
  ...adminOnly,
  async (req, res) => {
    try {
      const entered = String(req.body.transactionRef || "").trim();
      if (entered.length < 5) {
        return res.status(400).json({
          success: false,
          error: "Enter a valid TrxID to verify",
        });
      }

      const claim = await prisma.feePayment.findUnique({
        where: { id: req.params.id },
      });

      if (!claim || !claim.submittedByStudent) {
        return res.status(404).json({
          success: false,
          error: "Claim not found",
        });
      }

      if (claim.status !== "PENDING") {
        return res.status(400).json({
          success: false,
          error: `Claim is already ${claim.status}`,
        });
      }

      const stored = String(claim.transactionRef || "").trim();

      // Case-insensitive match (TrxIDs sometimes vary in case)
      if (stored.toLowerCase() !== entered.toLowerCase()) {
        return res.status(400).json({
          success: false,
          error: "TrxID does not match. Payment not verified.",
        });
      }

      const payment = await prisma.feePayment.update({
        where: { id: claim.id },
        data: {
          status: "APPROVED",
          reviewedByAdminEmail: req.user!.email,
          reviewedAt: new Date(),
        },
      });

      // Never send full trx back if you want it hidden from UI
      const { transactionRef: _t, ...safe } = payment;

      return res.json({
        success: true,
        message: "Payment verified and approved",
        payment: safe,
      });
    } catch (err: any) {
      console.error("[fees] verify:", err);
      return res.status(500).json({
        success: false,
        error: err?.message || "Verification failed",
      });
    }
  },
);
/** PATCH /api/admin/fees/claims/:id/reject */
router.patch(
  "/admin/fees/claims/:id/reject",
  ...adminOnly,
  async (req, res) => {
    try {
      const reason = String(req.body.reason || "").trim();
      if (!reason) {
        return res.status(400).json({
          success: false,
          error: "Rejection reason is required",
        });
      }
      const payment = await prisma.feePayment.update({
        where: { id: req.params.id },
        data: {
          status: "REJECTED",
          rejectionReason: reason,
          reviewedByAdminEmail: req.user!.email,
          reviewedAt: new Date(),
        },
      });
      return res.json({ success: true, payment });
    } catch (err: any) {
      console.error("[fees] reject:", err);
      return res.status(500).json({
        success: false,
        error: err?.message || "Reject failed",
      });
    }
  },
);

// ── Roster (monthly only) ─────────────────────────────────────────────────

/** GET /api/admin/fees/students */
router.get("/admin/fees/students", ...adminOnly, async (req, res) => {
  try {
    const sessionYear =
      (req.query.sessionYear as string) ||
      new Date().getFullYear().toString();
    const month = (req.query.month as string) || currentMonthKey();
    const search = ((req.query.search as string) || "").trim();
    const studentClass = ((req.query.studentClass as string) || "").trim();
    // "Section A" | "Section B" | ""
    const studentSection = ((req.query.studentSection as string) || "").trim();

    const students = await prisma.user.findMany({
      where: {
        role: "student",
        ...(studentClass && studentClass !== "All Classes"
          ? { studentClass }
          : {}),
        ...(studentSection && studentSection !== "All Sections"
          ? { studentSection }
          : {}),
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: "insensitive" as any } },
                { email: { contains: search, mode: "insensitive" as any } },
                { roll: { contains: search, mode: "insensitive" as any } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        name: true,
        email: true,
        studentClass: true,
        studentSection: true,
        roll: true,
      },
      orderBy: [
        { studentClass: "asc" },
        { studentSection: "asc" },
        { name: "asc" },
      ],
      take: 500,
    });

    const ids = students.map((s) => s.id);
    const classes = [
      ...new Set(students.map((s) => s.studentClass).filter(Boolean)),
    ] as string[];

    const [payments, structures] = await Promise.all([
      prisma.feePayment.findMany({
        where: {
          studentId: { in: ids },
          sessionYear,
          feeType: "MONTHLY",
          month,
          status: "APPROVED",
        },
      }),
      prisma.feeStructure.findMany({
        where: {
          studentClass: { in: classes.length ? classes : ["__none__"] },
          sessionYear,
          feeType: "MONTHLY",
        },
      }),
    ]);

    const dueFor = (cls: string) =>
      structures.find((s) => s.studentClass === cls)?.amount ?? 0;

    const data = students.map((s) => {
      const cls = s.studentClass ?? "";
      const paid = payments
        .filter((p) => p.studentId === s.id)
        .reduce((sum, p) => sum + p.amount, 0);
      const due = dueFor(cls);
      let status: "PAID" | "PARTIAL" | "DUE" = "DUE";
      if (due > 0 && paid >= due) status = "PAID";
      else if (paid > 0) status = "PARTIAL";

      return {
        id: s.id,
        name: s.name,
        email: s.email,
        studentClass: s.studentClass,
        studentSection: s.studentSection,
        roll: s.roll,
        monthly: { month, paid, due, status },
      };
    });

    const totalPaid = data.reduce((s, r) => s + r.monthly.paid, 0);
    const totalDue = data.reduce((s, r) => s + r.monthly.due, 0);
    const remaining = Math.max(0, totalDue - totalPaid);

    return res.json({
      success: true,
      data,
      month,
      sessionYear,
      summary: {
        totalPaid,
        totalDue,
        remaining,
        collectedPercent:
          totalDue > 0 ? Math.round((totalPaid / totalDue) * 100) : 0,
        studentCount: data.length,
        paidCount: data.filter((r) => r.monthly.status === "PAID").length,
        dueCount: data.filter((r) => r.monthly.status === "DUE").length,
        partialCount: data.filter((r) => r.monthly.status === "PARTIAL")
          .length,
      },
    });
  } catch (err: any) {
    console.error("[fees] roster:", err);
    return res.status(500).json({
      success: false,
      error: err?.message || "Failed to load roster",
    });
  }
});
// ── GET /api/student/fees ─────────────────────────────────────────────────

router.get(
  "/student/fees",
  requireAuth,
  requireRole("student"),
  async (req, res) => {
    try {
      const sessionYear = new Date().getFullYear().toString();
      const month = currentMonthKey();
      const studentClass = req.user!.studentClass ?? "";

      const [approved, pendingClaims, structures, exams] = await Promise.all([
        prisma.feePayment.findMany({
          where: {
            studentId: req.user!.id,
            sessionYear,
            status: "APPROVED",
          },
          orderBy: { paidAt: "desc" },
        }),
        prisma.feePayment.findMany({
          where: {
            studentId: req.user!.id,
            sessionYear,
            status: "PENDING",
          },
          orderBy: { paidAt: "desc" },
        }),
        prisma.feeStructure.findMany({
          where: { studentClass, sessionYear },
        }),
        prisma.exam.findMany({
          where: {
            studentClass,
            status: { not: "Cancelled" },
          },
          orderBy: { date: "asc" },
        }),
      ]);

      const amountOf = (feeType: string, examId?: string) =>
        structures.find(
          (s) =>
            s.feeType === feeType &&
            (feeType !== "EXAM" || s.examId === examId),
        )?.amount ?? 0;

      const statusOf = (paid: number, due: number) => {
        if (due <= 0) return paid > 0 ? "PAID" : "DUE";
        if (paid >= due) return "PAID";
        if (paid > 0) return "PARTIAL";
        return "DUE";
      };

      const monthlyPaid = approved
        .filter((p) => p.feeType === "MONTHLY" && p.month === month)
        .reduce((s, p) => s + p.amount, 0);
      const monthlyDue = amountOf("MONTHLY");

      const registrationPaid = approved
        .filter((p) => p.feeType === "REGISTRATION")
        .reduce((s, p) => s + p.amount, 0);
      const registrationDue = amountOf("REGISTRATION");

      const examFees = exams.map((exam) => {
        const due = amountOf("EXAM", exam.id);
        const paid = approved
          .filter((p) => p.feeType === "EXAM" && p.examId === exam.id)
          .reduce((s, p) => s + p.amount, 0);
        return {
          examId: exam.id,
          title: exam.title,
          date: exam.date,
          due,
          paid,
          status: statusOf(paid, due),
        };
      });

      return res.json({
        success: true,
        monthly: {
          month,
          paid: monthlyPaid,
          due: monthlyDue,
          status: statusOf(monthlyPaid, monthlyDue),
        },
        // optional: admin-created non-monthly structures
        otherFees: structures
          .filter((s) => s.feeType !== "MONTHLY" && s.feeType !== "EXAM")
          .map((s) => {
            const paid = approved
              .filter((p) => p.feeType === s.feeType)
              .reduce((sum, p) => sum + p.amount, 0);
            return {
              feeType: s.feeType,
              label:
                s.feeType === "REGISTRATION" ? "Registration fee" : s.feeType,
              paid,
              due: s.amount,
              status: statusOf(paid, s.amount),
            };
          }),
        history: approved,
        pendingClaims,
      });
    } catch (err: any) {
      console.error("[fees] student fees:", err);
      return res.status(500).json({
        success: false,
        error: err?.message || "Failed to fetch fees",
      });
    }
  },
);

// ── POST /api/student/fees/claim ──────────────────────────────────────────

router.post(
  "/student/fees/claim",
  requireAuth,
  requireRole("student"),
  handleScreenshot,
  async (req, res) => {
    try {
      const feeType = parseFeeType(req.body.feeType);
      const sessionYear = String(
        req.body.sessionYear || new Date().getFullYear(),
      ).trim();
      const month = req.body.month ? String(req.body.month).trim() : null;
      const examId = req.body.examId ? String(req.body.examId).trim() : null;
      const trx = String(req.body.transactionRef || "").trim();
      const phone = String(
        req.body.senderPhone || req.body.senderNumber || "",
      ).trim();

      if (!feeType || !req.body.method || !trx) {
        return res.status(400).json({
          success: false,
          error: "feeType, method, and transactionRef are required",
        });
      }
      if (trx.length < 5) {
        return res.status(400).json({
          success: false,
          error: "Valid TrxID is required",
        });
      }

      let resolved: { method: PaymentMethod; gateway: string | null };
      try {
        resolved = resolvePayment(req.body.method);
      } catch {
        return res.status(400).json({
          success: false,
          error: "Invalid payment method",
        });
      }

      if (resolved.method === "MOBILE_BANKING" && !/^01\d{9}$/.test(phone)) {
        return res.status(400).json({
          success: false,
          error: "Sender number must be 11 digits starting with 01",
        });
      }
      if (feeType === "MONTHLY" && !month) {
        return res.status(400).json({
          success: false,
          error: "month is required for MONTHLY",
        });
      }
      if (feeType === "EXAM" && !examId) {
        return res.status(400).json({
          success: false,
          error: "examId is required for EXAM",
        });
      }

      const studentClass = req.user!.studentClass ?? "";
      const structure = await prisma.feeStructure.findFirst({
        where: {
          studentClass,
          feeType,
          sessionYear,
          ...(feeType === "EXAM" ? { examId } : {}),
        },
      });
      if (!structure) {
        return res.status(400).json({
          success: false,
          error: "Fee structure not configured for your class",
        });
      }

      const duplicate = await prisma.feePayment.findFirst({
        where: {
          studentId: req.user!.id,
          feeType,
          sessionYear,
          status: { in: ["APPROVED", "PENDING"] },
          ...(feeType === "MONTHLY" ? { month } : {}),
          ...(feeType === "EXAM" ? { examId } : {}),
        },
      });
      if (duplicate) {
        return res.status(409).json({
          success: false,
          error:
            duplicate.status === "PENDING"
              ? "You already have a pending claim"
              : "This fee is already paid",
        });
      }

      let screenshotUrl: string | undefined;
      if (req.file) {
        const ext = req.file.mimetype.split("/")[1];
        const key = `payment-proofs/${req.user!.id}/${Date.now()}.${ext}`;
        screenshotUrl = await uploadBufferToR2(
          req.file.buffer,
          key,
          req.file.mimetype,
        );
      }

      const claim = await prisma.feePayment.create({
        data: {
          studentId: req.user!.id,
          studentEmail: req.user!.email,
          studentName: req.user!.name,
          studentClass,
          feeType,
          amount: structure.amount,
          method: resolved.method,
          gateway: resolved.gateway,
          sessionYear,
          month: feeType === "MONTHLY" ? month : null,
          examId: feeType === "EXAM" ? examId : null,
          transactionRef: trx,
          senderPhone: phone || null,
          screenshotUrl,
          receiptNo: generateReceiptNo(),
          status: "PENDING",
          submittedByStudent: true,
        },
      });

      return res.status(201).json({ success: true, claim });
    } catch (err: any) {
      console.error("[fees] claim:", err);
      return res.status(500).json({
        success: false,
        error: err?.message || "Failed to submit claim",
      });
    }
  },
);

export default router;
