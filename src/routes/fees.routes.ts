import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole } from "../middleware/session.js";
import multer from "multer";


const router = Router();

function generateReceiptNo() {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `RCPT-${stamp}-${rand}`;
}
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB, same cap as avatars
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    cb(null, allowed.includes(file.mimetype));
  },
});

const currentMonthKey = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
};

// ── 1. Fee structure management ──────────────────────────────────────────

router.post(
  "/admin/fees/structure",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    try {
      const { studentClass, feeType, amount, sessionYear, examId } = req.body;

      if (!studentClass || !feeType || amount == null || !sessionYear) {
        return res.status(400).json({
          error: "studentClass, feeType, amount, and sessionYear are required",
        });
      }
      if (feeType === "EXAM" && !examId) {
        return res
          .status(400)
          .json({ error: "examId is required for EXAM fee type" });
      }

      const structure = await prisma.feeStructure.upsert({
        where: {
          studentClass_feeType_examId_sessionYear: {
            studentClass,
            feeType,
            examId: examId ?? null,
            sessionYear,
          },
        },
        update: { amount },
        create: {
          studentClass,
          feeType,
          amount,
          sessionYear,
          examId: examId ?? null,
        },
      });

      res.json(structure);
    } catch (err) {
      console.error("[fees] create structure failed:", err);
      res.status(500).json({ error: "Failed to save fee structure" });
    }
  },
);

router.get(
  "/admin/fees/structure",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    try {
      const { studentClass, sessionYear } = req.query as Record<string, string>;
      const structures = await prisma.feeStructure.findMany({
        where: {
          ...(studentClass ? { studentClass } : {}),
          ...(sessionYear ? { sessionYear } : {}),
        },
        orderBy: [{ studentClass: "asc" }, { feeType: "asc" }],
      });
      res.json(structures);
    } catch (err) {
      console.error("[fees] list structure failed:", err);
      res.status(500).json({ error: "Failed to fetch fee structure" });
    }
  },
);

// ── 2. Admin roster with paid/due status ─────────────────────────────────

// GET /api/admin/fees/students
// ?studentClass=&studentSection=&sessionYear=&month=&status=PAID|PARTIAL|DUE&search=&page=&limit=
router.get(
  "/admin/fees/students",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    try {
      const {
        studentClass,
        studentSection,
        sessionYear = new Date().getFullYear().toString(),
        month = currentMonthKey(),
        status, // filter on monthly status
        search,
        page = "1",
        limit = "20",
      } = req.query as Record<string, string>;

      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

      const students = await prisma.user.findMany({
        where: {
          role: "student",
          ...(studentClass ? { studentClass } : {}),
          ...(studentSection ? { studentSection } : {}),
          ...(search
            ? {
                OR: [
                  { name: { contains: search, mode: "insensitive" } },
                  { email: { contains: search, mode: "insensitive" } },
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
        orderBy: [{ studentClass: "asc" }, { roll: "asc" }],
      });

      const studentIds = students.map((s) => s.id);
      const classes = [
        ...new Set(students.map((s) => s.studentClass).filter(Boolean)),
      ] as string[];

      const [payments, structures] = await Promise.all([
        prisma.feePayment.findMany({
          where: { studentId: { in: studentIds }, sessionYear },
        }),
        prisma.feeStructure.findMany({
          where: { studentClass: { in: classes }, sessionYear },
        }),
      ]);

      const structureAmount = (cls: string, feeType: string) =>
        structures.find((s) => s.studentClass === cls && s.feeType === feeType)
          ?.amount ?? 0;

      const computeStatus = (
        paid: number,
        due: number,
      ): "PAID" | "PARTIAL" | "DUE" => {
        if (due <= 0) return paid > 0 ? "PAID" : "DUE";
        if (paid >= due) return "PAID";
        if (paid > 0) return "PARTIAL";
        return "DUE";
      };

      let rows = students.map((s) => {
        const own = payments.filter((p) => p.studentId === s.id);
        const cls = s.studentClass ?? "";

        const monthlyPaid = own
          .filter((p) => p.feeType === "MONTHLY" && p.month === month)
          .reduce((sum, p) => sum + p.amount, 0);
        const monthlyDue = structureAmount(cls, "MONTHLY");

        const registrationPaid = own
          .filter((p) => p.feeType === "REGISTRATION")
          .reduce((sum, p) => sum + p.amount, 0);
        const registrationDue = structureAmount(cls, "REGISTRATION");

        return {
          id: s.id,
          name: s.name,
          email: s.email,
          studentClass: s.studentClass,
          studentSection: s.studentSection,
          roll: s.roll,
          monthly: {
            month,
            paid: monthlyPaid,
            due: monthlyDue,
            status: computeStatus(monthlyPaid, monthlyDue),
          },
          registration: {
            paid: registrationPaid,
            due: registrationDue,
            status: computeStatus(registrationPaid, registrationDue),
          },
          examsPaid: own
            .filter((p) => p.feeType === "EXAM")
            .map((p) => p.examId),
        };
      });

      if (status) {
        rows = rows.filter((r) => r.monthly.status === status);
      }

      const total = rows.length;
      const start = (pageNum - 1) * limitNum;
      const paginated = rows.slice(start, start + limitNum);

      res.json({ data: paginated, total, page: pageNum, limit: limitNum });
    } catch (err) {
      console.error("[fees] student roster failed:", err);
      res.status(500).json({ error: "Failed to fetch fee status" });
    }
  },
);

// ── 3. Recording & listing payments ──────────────────────────────────────

router.post(
  "/admin/fees/payments",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    try {
      const {
        studentId,
        feeType,
        amount,
        method,
        sessionYear,
        month,
        examId,
        note,
      } = req.body;

      if (!studentId || !feeType || amount == null || !method || !sessionYear) {
        return res.status(400).json({
          error:
            "studentId, feeType, amount, method, and sessionYear are required",
        });
      }
      if (feeType === "MONTHLY" && !month) {
        return res
          .status(400)
          .json({ error: "month is required for MONTHLY payments" });
      }
      if (feeType === "EXAM" && !examId) {
        return res
          .status(400)
          .json({ error: "examId is required for EXAM payments" });
      }

      const student = await prisma.user.findUnique({
        where: { id: studentId },
      });
      if (!student || student.role !== "student") {
        return res.status(404).json({ error: "Student not found" });
      }

      const duplicate = await prisma.feePayment.findFirst({
        where: {
          studentId,
          feeType,
          sessionYear,
          status: { in: ["APPROVED", "PENDING"] }, // ADDED
          ...(feeType === "MONTHLY" ? { month } : {}),
          ...(feeType === "EXAM" ? { examId } : {}),
        },
      });
      if (duplicate) {
        return res.status(409).json({
          error: "A payment for this student/fee/period already exists",
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
          amount,
          method,
          sessionYear,
          month: feeType === "MONTHLY" ? month : null,
          examId: feeType === "EXAM" ? examId : null,
          note,
          receiptNo: generateReceiptNo(),
          recordedByAdminEmail: req.user!.email,
          status: "APPROVED", // admin-entered payments are trusted immediately
          submittedByStudent: false,
        },
      });

      res.status(201).json(payment);
    } catch (err) {
      console.error("[fees] record payment failed:", err);
      res.status(500).json({ error: "Failed to record payment" });
    }
  },
);

router.get(
  "/admin/fees/payments",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    try {
      const { studentEmail, feeType, sessionYear, from, to } =
        req.query as Record<string, string>;

      const payments = await prisma.feePayment.findMany({
        where: {
          ...(studentEmail ? { studentEmail } : {}),
          ...(feeType ? { feeType: feeType as any } : {}),
          ...(sessionYear ? { sessionYear } : {}),
          ...(from || to
            ? {
                paidAt: {
                  ...(from ? { gte: new Date(from) } : {}),
                  ...(to ? { lte: new Date(to) } : {}),
                },
              }
            : {}),
        },
        orderBy: { paidAt: "desc" },
      });

      res.json(payments);
    } catch (err) {
      console.error("[fees] payment history failed:", err);
      res.status(500).json({ error: "Failed to fetch payment history" });
    }
  },
);

// ── 4. Student self-service ──────────────────────────────────────────────

// GET /api/student/fees
// Returns monthly status for the current month, registration status,
// exam fee status for the student's class, and full payment history.
router.get("/student/fees", requireAuth, requireRole("student"), async (req, res) => {
  try {
    const sessionYear = new Date().getFullYear().toString();
    const month = currentMonthKey();
    const studentClass = req.user!.studentClass ?? "";

    // ─── REPLACE the old single `payments` query with these two ───
    const payments = await prisma.feePayment.findMany({
      where: { studentId: req.user!.id, sessionYear, status: "APPROVED" },
      orderBy: { paidAt: "desc" },
    });

    const pendingClaims = await prisma.feePayment.findMany({
      where: { studentId: req.user!.id, sessionYear, status: "PENDING" },
      orderBy: { paidAt: "desc" },
    });
    // ─────────────────────────────────────────────────────────────

    const [structures, exams] = await Promise.all([
      prisma.feeStructure.findMany({
        where: { studentClass, sessionYear },
      }),
      prisma.exam.findMany({
        where: { studentClass, status: { not: "Cancelled" } },
        orderBy: { date: "asc" },
      }),
    ]);

    const structureAmount = (feeType: string, examId?: string) =>
      structures.find(
        (s) => s.feeType === feeType && (feeType !== "EXAM" || s.examId === examId)
      )?.amount ?? 0;

    const computeStatus = (paid: number, due: number): "PAID" | "PARTIAL" | "DUE" => {
      if (due <= 0) return paid > 0 ? "PAID" : "DUE";
      if (paid >= due) return "PAID";
      if (paid > 0) return "PARTIAL";
      return "DUE";
    };

    const monthlyPaid = payments
      .filter((p) => p.feeType === "MONTHLY" && p.month === month)
      .reduce((sum, p) => sum + p.amount, 0);
    const monthlyDue = structureAmount("MONTHLY");

    const registrationPaid = payments
      .filter((p) => p.feeType === "REGISTRATION")
      .reduce((sum, p) => sum + p.amount, 0);
    const registrationDue = structureAmount("REGISTRATION");

    const examFees = exams.map((exam) => {
      const due = structureAmount("EXAM", exam.id);
      const paid = payments
        .filter((p) => p.feeType === "EXAM" && p.examId === exam.id)
        .reduce((sum, p) => sum + p.amount, 0);
      return {
        examId: exam.id,
        title: exam.title,
        date: exam.date,
        due,
        paid,
        status: computeStatus(paid, due),
      };
    });

    // ─── ADD pendingClaims here in the response ───
    res.json({
      monthly: { month, paid: monthlyPaid, due: monthlyDue, status: computeStatus(monthlyPaid, monthlyDue) },
      registration: { paid: registrationPaid, due: registrationDue, status: computeStatus(registrationPaid, registrationDue) },
      exams: examFees,
      history: payments,
      pendingClaims,
    });
  } catch (err) {
    console.error("[fees] student fee status failed:", err);
    res.status(500).json({ error: "Failed to fetch your fee status" });
  }
});
router.get(
  "/student/exams/:id/entry-form",
  requireAuth,
  requireRole("student"),
  async (req, res) => {
    try {
      const examId = req.params.id;

      const paid = await prisma.feePayment.findFirst({
        where: { studentId: req.user!.id, feeType: "EXAM", examId },
      });

      if (!paid) {
        return res.status(403).json({
          error: "EXAM_FEE_UNPAID",
          message: "Exam fee has not been recorded as paid for this exam yet.",
        });
      }

      const exam = await prisma.exam.findUnique({ where: { id: examId } });
      if (!exam) {
        return res.status(404).json({ error: "Exam not found" });
      }

      res.json({
        exam,
        receiptNo: paid.receiptNo,
        paidAt: paid.paidAt,
        student: {
          id: req.user!.id,
          name: req.user!.name,
          email: req.user!.email,
        },
      });
    } catch (err) {
      console.error("[fees] entry form failed:", err);
      res.status(500).json({ error: "Failed to generate entry form" });
    }
  },
);

// POST /api/student/fees/claim
// multipart/form-data: feeType, amount, method, sessionYear, month?, examId?, transactionRef, screenshot?(file)
router.post(
  "/student/fees/claim",
  requireAuth,
  requireRole("student"),
  upload.single("screenshot"),
  async (req, res) => {
    try {
      const { feeType, amount, method, sessionYear, month, examId, transactionRef } = req.body;

      if (!feeType || !amount || !method || !sessionYear || !transactionRef) {
        return res.status(400).json({
          error: "feeType, amount, method, sessionYear, and transactionRef are required",
        });
      }
      if (feeType === "MONTHLY" && !month) {
        return res.status(400).json({ error: "month is required for MONTHLY claims" });
      }
      if (feeType === "EXAM" && !examId) {
        return res.status(400).json({ error: "examId is required for EXAM claims" });
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
          error:
            duplicate.status === "PENDING"
              ? "You already have a pending claim for this fee period"
              : "This fee period is already marked paid",
        });
      }

      let screenshotUrl: string | undefined;
      if (req.file) {
        const ext = req.file.mimetype.split("/")[1];
        const key = `payment-proofs/${req.user!.id}/${crypto.randomUUID()}.${ext}`;
        screenshotUrl = await uploadBufferToR2(req.file.buffer, key, req.file.mimetype);
      }

      const claim = await prisma.feePayment.create({
        data: {
          studentId: req.user!.id,
          studentEmail: req.user!.email,
          studentName: req.user!.name,
          studentClass: req.user!.studentClass ?? "",
          feeType,
          amount: Number(amount),
          method,
          sessionYear,
          month: feeType === "MONTHLY" ? month : null,
          examId: feeType === "EXAM" ? examId : null,
          transactionRef,
          screenshotUrl,
          receiptNo: generateReceiptNo(),
          status: "PENDING",
          submittedByStudent: true,
        },
      });

      res.status(201).json(claim);
    } catch (err) {
      console.error("[fees] student claim submission failed:", err);
      res.status(500).json({ error: "Failed to submit payment claim" });
    }
  }
);

// GET /api/admin/fees/claims?status=PENDING
router.get(
  "/admin/fees/claims",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    try {
      const { status = "PENDING" } = req.query as Record<string, string>;
      const claims = await prisma.feePayment.findMany({
        where: { submittedByStudent: true, status: status as any },
        orderBy: { paidAt: "desc" },
      });
      res.json(claims);
    } catch (err) {
      console.error("[fees] list claims failed:", err);
      res.status(500).json({ error: "Failed to fetch claims" });
    }
  }
);

// PATCH /api/admin/fees/claims/:id/approve
router.patch(
  "/admin/fees/claims/:id/approve",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    try {
      const claim = await prisma.feePayment.update({
        where: { id: req.params.id },
        data: {
          status: "APPROVED",
          reviewedByAdminEmail: req.user!.email,
          reviewedAt: new Date(),
        },
      });
      res.json(claim);
    } catch (err) {
      console.error("[fees] approve claim failed:", err);
      res.status(500).json({ error: "Failed to approve claim" });
    }
  }
);

// PATCH /api/admin/fees/claims/:id/reject
// Body: { reason: string }
router.patch(
  "/admin/fees/claims/:id/reject",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    try {
      const { reason } = req.body;
      if (!reason) {
        return res.status(400).json({ error: "A rejection reason is required" });
      }
      const claim = await prisma.feePayment.update({
        where: { id: req.params.id },
        data: {
          status: "REJECTED",
          rejectionReason: reason,
          reviewedByAdminEmail: req.user!.email,
          reviewedAt: new Date(),
        },
      });
      res.json(claim);
    } catch (err) {
      console.error("[fees] reject claim failed:", err);
      res.status(500).json({ error: "Failed to reject claim" });
    }
  }
);

export default router;
