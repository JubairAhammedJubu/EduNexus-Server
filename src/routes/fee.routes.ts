import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole } from "../middleware/session.js";
import { getSsl, uniqueTranId } from "../config/sslCommerz-lts.js";
import type { FeeType } from "@prisma/client";

const router = Router();
const adminOnly = [requireAuth, requireRole("admin")] as const;
const studentOnly = [requireAuth, requireRole("student")] as const;

const CLASSES = ["Class 6", "Class 7", "Class 8", "Class 9", "Class 10"];

// Pending SSL payment eto minute por stale dhora hobe (query fail korle)
const STALE_MS = 30 * 60 * 1000;
// SSL monthly payment e fine included thakle note e ei marker thake
const FINE_MARK = "SSL_INCLUDES_FINE:";

function receiptNo() {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `RCPT-${stamp}-${rand}`;
}

function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function isObjectId(id: string) {
  return /^[a-f\d]{24}$/i.test(id);
}

function clientUrl() {
  return process.env.CLIENT_URL || "http://localhost:3000";
}

function serverUrl() {
  return process.env.SERVER_URL || "http://localhost:5000";
}

function methodLabel(p: {
  method: string;
  gateway?: string | null;
  gatewayStatus?: string | null;
}) {
  if (p.gateway === "SSLCommerz" || p.gatewayStatus) return "SSLCommerz";
  if (p.method === "CASH") return "Cash";
  return p.gateway || p.method;
}

function sessionMonths(sessionYear: string) {
  const startY = Number(sessionYear);
  const now = new Date();
  const endY = now.getFullYear();
  const endM = now.getMonth() + 1;
  const months: string[] = [];
  let y = startY;
  let m = 1;
  while (y < endY || (y === endY && m <= endM)) {
    months.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return months;
}

async function getSettings(sessionYear: string) {
  return prisma.feeSettings.upsert({
    where: { sessionYear },
    update: {},
    create: { sessionYear, fineAmount: 500, lockAfterMonths: 3 },
  });
}

async function getMonthlyRate(studentClass: string, sessionYear: string) {
  const row = await prisma.feeStructure.findUnique({
    where: {
      studentClass_feeType_sessionYear: {
        studentClass,
        feeType: "MONTHLY",
        sessionYear,
      },
    },
  });
  return row?.amount ?? null;
}

async function monthlySnapshot(
  studentId: string,
  studentClass: string,
  sessionYear: string,
) {
  const settings = await getSettings(sessionYear);
  const rate = (await getMonthlyRate(studentClass, sessionYear)) ?? 0;
  const months = sessionMonths(sessionYear);

  const paid = await prisma.feePayment.findMany({
    where: {
      studentId,
      feeType: "MONTHLY",
      sessionYear,
      status: { in: ["APPROVED", "PENDING"] },
      month: { in: months },
    },
    select: { month: true, status: true, amount: true },
  });

  const approvedMonths = new Set(
    paid.filter((p) => p.status === "APPROVED" && p.month).map((p) => p.month!),
  );
  const unpaidMonths = months.filter((m) => !approvedMonths.has(m));

  const finePaid = await prisma.feePayment.findFirst({
    where: {
      studentId,
      feeType: "FINE",
      sessionYear,
      status: "APPROVED",
    },
  });

  const fineApplicable = unpaidMonths.length >= 1;
  const fineDue = fineApplicable && !finePaid ? settings.fineAmount : 0;
  const blocked = unpaidMonths.length > settings.lockAfterMonths;

  return {
    settings,
    rate,
    months,
    unpaidMonths,
    fineApplicable,
    fineDue,
    finePaid: Boolean(finePaid),
    blocked,
  };
}

async function refreshFeeLock(
  studentId: string,
  studentClass: string,
  sessionYear: string,
  unblockedBy?: string,
) {
  const snap = await monthlySnapshot(studentId, studentClass, sessionYear);
  await prisma.user.update({
    where: { id: studentId },
    data: snap.blocked
      ? { feeAccessBlocked: true, feeBlockedAt: new Date() }
      : {
          feeAccessBlocked: false,
          feeUnblockedAt: new Date(),
          ...(unblockedBy ? { feeUnblockedBy: unblockedBy } : {}),
        },
  });
  return snap;
}

function catalogVisibleTo(
  studentClass: string,
  studentSection: string | null | undefined,
) {
  return {
    isActive: true,
    OR: [{ studentClass: "ALL" }, { studentClass }],
    AND: [
      {
        OR: [
          { section: null },
          ...(studentSection ? [{ section: studentSection }] : []),
        ],
      },
    ],
  };
}

function cashPaymentIds() {
  const no = receiptNo();
  return { receiptNo: no, gatewayTranId: `CASH-${no}` };
}

// ── SSLCommerz helpers ─────────────────────────────────────────────────

/**
 * Gateway theke validate kore payment ta PAID hishebe mark kore.
 * - valId chhara kokhono paid mark kora hobe na (age chhilo, security bug)
 * - tran_id ar amount match na korle reject
 * - CANCELLED / FAILED hoye gelew, gateway VALID bolle abar PAID kora jay
 *   (user ekta purono tab theke pay korle taka jeno hariye na jay)
 */
async function markSslPaid(tranId: string, valId?: string) {
  if (!tranId || !valId) return false;

  const existing = await prisma.feePayment.findFirst({
    where: { gatewayTranId: tranId },
  });
  if (!existing) return false;

  const v: any = await getSsl().validate({ val_id: valId });
  const ok = v?.status === "VALID" || v?.status === "VALIDATED";
  if (!ok) return false;
  if (v?.tran_id && String(v.tran_id) !== tranId) return false;

  const expected = existing.gatewayAmount ?? existing.amount;
  if (v?.amount && Math.abs(Number(v.amount) - Number(expected)) > 0.01) {
    console.error("[ssl] amount mismatch", tranId, v.amount, expected);
    return false;
  }

  const now = new Date();
  const result = await prisma.feePayment.updateMany({
    where: {
      gatewayTranId: tranId,
      gatewayStatus: { in: ["PENDING", "CANCELLED", "FAILED"] },
    },
    data: {
      gatewayStatus: "PAID",
      status: "APPROVED",
      gatewayValId: valId,
      gatewayPaidAt: now,
      paidAt: now,
    },
  });

  // Shudhu prothom bar (success + IPN duita ashle duplicate na hoy)
  if (
    result.count > 0 &&
    existing.feeType === "MONTHLY" &&
    existing.note?.startsWith(FINE_MARK)
  ) {
    const fineAmount = Number(existing.note.slice(FINE_MARK.length));
    if (Number.isFinite(fineAmount) && fineAmount > 0) {
      try {
        const alreadyFined = await prisma.feePayment.findFirst({
          where: {
            studentId: existing.studentId,
            feeType: "FINE",
            sessionYear: existing.sessionYear,
            status: "APPROVED",
          },
        });
        if (!alreadyFined) {
          await prisma.feePayment.create({
            data: {
              studentId: existing.studentId,
              studentEmail: existing.studentEmail,
              studentName: existing.studentName,
              studentClass: existing.studentClass,
              feeType: "FINE",
              amount: fineAmount,
              method: "BANK",
              month: existing.month,
              sessionYear: existing.sessionYear,
              note: "Monthly due fine (paid with monthly fee)",
              receiptNo: receiptNo(),
              status: "APPROVED",
              submittedByStudent: true,
              gateway: "SSLCommerz",
              gatewayStatus: "PAID",
              gatewayTranId: `${tranId}-FINE`,
              gatewayValId: valId,
              gatewayAmount: fineAmount,
              gatewayPaidAt: now,
              paidAt: now,
              transactionRef: tranId,
            },
          });
        }
      } catch (e) {
        console.error("[ssl] fine row create failed:", e);
      }
    }
  }

  await refreshFeeLock(
    existing.studentId,
    existing.studentClass,
    existing.sessionYear,
  );
  return true;
}

async function markSslClosed(
  tranId: string,
  gatewayStatus: "FAILED" | "CANCELLED",
) {
  if (!tranId) return;
  await prisma.feePayment.updateMany({
    where: { gatewayTranId: tranId, gatewayStatus: "PENDING" },
    data: { gatewayStatus, status: "REJECTED" },
  });
}

/**
 * Browser "back" dile SSLCommerz cancel/fail URL hit kore na, tai row PENDING
 * thekei jay ar notun payment atke jay. Ei function:
 *  1. gateway ke jiggesh kore (transaction query) -- asole paid hole APPROVE kore
 *  2. paid na hole (ba force / purono hole) CANCELLED + REJECTED kore dey
 *
 * opts.force     -> query inconclusive hole-o cancel kore
 * opts.minAgeMs  -> eta-r cheye notun pending gulo ke chhuye na
 */
async function releaseStaleSslPending(
  where: Record<string, unknown>,
  opts: { force?: boolean; minAgeMs?: number } = {},
) {
  const { force = false, minAgeMs = 0 } = opts;

  const pendings = await prisma.feePayment.findMany({
    where: {
      ...(where as any),
      gateway: "SSLCommerz",
      status: "PENDING",
      gatewayStatus: "PENDING",
    },
  });

  for (const p of pendings) {
    if (!p.gatewayTranId) continue;

    const age = Date.now() - new Date(p.paidAt).getTime();
    if (age < minAgeMs) continue;

    let queried = false;
    try {
      const q: any = await (getSsl() as any).transactionQueryByTransactionId({
        tran_id: p.gatewayTranId,
      });
      queried = true;
      const valid = q?.element?.find(
        (e: any) => e.status === "VALID" || e.status === "VALIDATED",
      );
      if (valid) {
        await markSslPaid(p.gatewayTranId, valid.val_id);
        continue; // asole paid, cancel korbo na
      }
    } catch (e) {
      console.error("[ssl] tx query failed:", e);
    }

    if (queried || force || age > STALE_MS) {
      await prisma.feePayment.updateMany({
        where: { id: p.id, gatewayStatus: "PENDING" },
        data: { gatewayStatus: "CANCELLED", status: "REJECTED" },
      });
    }
  }
}

// ── Student search (Mongo-safe, no mode: insensitive) ──────────────────

router.get("/admin/students", ...adminOnly, async (req, res) => {
  try {
    const q = String(req.query.search || "").trim().toLowerCase();

    const students = await prisma.user.findMany({
      where: { role: "student" },
      select: {
        id: true,
        name: true,
        email: true,
        studentClass: true,
        studentSection: true,
      },
      take: 300,
    });

    const filtered = q
      ? students.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            s.email.toLowerCase().includes(q),
        )
      : students.slice(0, 20);

    return res.json({ success: true, students: filtered.slice(0, 15) });
  } catch (err: any) {
    console.error("[fees] student search:", err);
    return res.status(500).json({ error: "Failed to search students" });
  }
});

// ── Structure ──────────────────────────────────────────────────────────

router.get("/admin/fees/structure", ...adminOnly, async (req, res) => {
  try {
    const sessionYear = String(
      req.query.sessionYear || new Date().getFullYear(),
    );
    const structures = await prisma.feeStructure.findMany({
      where: { sessionYear, feeType: "MONTHLY" },
      orderBy: { studentClass: "asc" },
    });
    const settings = await getSettings(sessionYear);
    return res.json({ success: true, sessionYear, structures, settings });
  } catch (err: any) {
    console.error("[fees] get structure:", err);
    return res
      .status(500)
      .json({ error: err?.message || "Failed to load structure" });
  }
});

router.put("/admin/fees/structure", ...adminOnly, async (req, res) => {
  try {
    const studentClass = String(req.body.studentClass || "").trim();
    const sessionYear = String(
      req.body.sessionYear || new Date().getFullYear(),
    );
    const amount = Number(req.body.amount);

    if (!CLASSES.includes(studentClass)) {
      return res.status(400).json({ error: "Invalid class" });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "amount must be > 0" });
    }

    const structure = await prisma.feeStructure.upsert({
      where: {
        studentClass_feeType_sessionYear: {
          studentClass,
          feeType: "MONTHLY",
          sessionYear,
        },
      },
      update: { amount },
      create: { studentClass, feeType: "MONTHLY", amount, sessionYear },
    });
    return res.json({ success: true, structure });
  } catch (err: any) {
    console.error("[fees] put structure:", err);
    return res
      .status(500)
      .json({ error: err?.message || "Failed to update structure" });
  }
});

router.post("/admin/fees/structure/seed", ...adminOnly, async (req, res) => {
  try {
    const sessionYear = String(
      req.body?.sessionYear || new Date().getFullYear(),
    );

    const defaults: Record<string, number> = {
      "Class 6": 1200,
      "Class 7": 1300,
      "Class 8": 1400,
      "Class 9": 1500,
      "Class 10": 1600,
    };

    const structures = [];
    for (const [studentClass, amount] of Object.entries(defaults)) {
      const row = await prisma.feeStructure.upsert({
        where: {
          studentClass_feeType_sessionYear: {
            studentClass,
            feeType: "MONTHLY",
            sessionYear,
          },
        },
        update: {},
        create: { studentClass, feeType: "MONTHLY", amount, sessionYear },
      });
      structures.push(row);
    }

    const settings = await prisma.feeSettings.upsert({
      where: { sessionYear },
      update: {},
      create: { sessionYear, fineAmount: 500, lockAfterMonths: 3 },
    });

    return res.json({
      success: true,
      message: `Seeded monthly fees + settings for ${sessionYear}`,
      structures,
      settings,
    });
  } catch (err: any) {
    console.error("[fees] structure seed:", err);
    return res.status(500).json({
      error: err?.message || "Failed to seed fee structure",
    });
  }
});

// ── Catalog ────────────────────────────────────────────────────────────

router.get("/admin/fees/catalog", ...adminOnly, async (req, res) => {
  try {
    const sessionYear = String(
      req.query.sessionYear || new Date().getFullYear(),
    );
    const catalog = await prisma.feeCatalog.findMany({
      where: { sessionYear },
      orderBy: { createdAt: "desc" },
    });
    return res.json({ success: true, catalog });
  } catch (err: any) {
    console.error("[fees] catalog list:", err);
    return res
      .status(500)
      .json({ error: err?.message || "Failed to load catalog" });
  }
});

router.post("/admin/fees/catalog", ...adminOnly, async (req, res) => {
  try {
    const title = String(req.body.title || "").trim();
    const feeType = String(req.body.feeType || "CUSTOM") as FeeType;
    const amount = Number(req.body.amount);
    const studentClass = String(req.body.studentClass || "ALL").trim();
    const sessionYear = String(
      req.body.sessionYear || new Date().getFullYear(),
    );

    if (!title) return res.status(400).json({ error: "title is required" });
    if (!["EXAM", "CUSTOM"].includes(feeType)) {
      return res.status(400).json({ error: "feeType must be EXAM or CUSTOM" });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "amount must be > 0" });
    }

    const item = await prisma.feeCatalog.create({
      data: {
        title,
        description: req.body.description ? String(req.body.description) : null,
        feeType,
        amount,
        studentClass,
        section: req.body.section ? String(req.body.section) : null,
        sessionYear,
        dueDate: req.body.dueDate ? new Date(req.body.dueDate) : null,
        examId: req.body.examId || null,
        createdByEmail: req.user!.email,
      },
    });
    return res.status(201).json({ success: true, catalog: item });
  } catch (err: any) {
    console.error("[fees] catalog create:", err);
    return res
      .status(500)
      .json({ error: err?.message || "Failed to create fee" });
  }
});

router.patch("/admin/fees/catalog/:id", ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isObjectId(id)) return res.status(400).json({ error: "Invalid id" });

    const data: Record<string, unknown> = {};
    if (req.body.title !== undefined) data.title = String(req.body.title).trim();
    if (req.body.description !== undefined) {
      data.description = req.body.description
        ? String(req.body.description)
        : null;
    }
    if (req.body.amount !== undefined) {
      const amount = Number(req.body.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: "amount must be > 0" });
      }
      data.amount = amount;
    }
    if (req.body.isActive !== undefined) data.isActive = Boolean(req.body.isActive);
    if (req.body.dueDate !== undefined) {
      data.dueDate = req.body.dueDate ? new Date(req.body.dueDate) : null;
    }

    const item = await prisma.feeCatalog.update({ where: { id }, data });
    return res.json({ success: true, catalog: item });
  } catch (err: any) {
    if (err.code === "P2025") return res.status(404).json({ error: "Fee not found" });
    console.error("[fees] catalog patch:", err);
    return res
      .status(500)
      .json({ error: err?.message || "Failed to update fee" });
  }
});

// ── Admin cash ─────────────────────────────────────────────────────────

router.post("/admin/fees/payments", ...adminOnly, async (req, res) => {
  try {
    const studentId = String(req.body.studentId || "");
    const source = String(req.body.source || "").toUpperCase();
    const sessionYear = String(
      req.body.sessionYear || new Date().getFullYear(),
    );
    const note = req.body.note ? String(req.body.note).trim() : null;
    const payFine = Boolean(req.body.payFine);

    if (!isObjectId(studentId)) {
      return res.status(400).json({ error: "Valid studentId is required" });
    }
    if (!["MONTHLY", "EXAM", "CATALOG"].includes(source)) {
      return res
        .status(400)
        .json({ error: "source must be MONTHLY | EXAM | CATALOG" });
    }

    const student = await prisma.user.findUnique({ where: { id: studentId } });
    if (!student || student.role !== "student") {
      return res.status(404).json({ error: "Student not found" });
    }

    const studentClass = student.studentClass || "";
    const created = [];

    if (source === "MONTHLY") {
      const month = String(req.body.month || monthKey());
      let amount = Number(req.body.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        const rate = await getMonthlyRate(studentClass, sessionYear);
        if (rate == null) {
          return res
            .status(400)
            .json({ error: "Monthly rate not set for this class" });
        }
        amount = rate;
      }

      // Student er atke thaka SSL pending thakle age clear kori
      await releaseStaleSslPending(
        { studentId, feeType: "MONTHLY", month, sessionYear },
        { force: true },
      );

      const dup = await prisma.feePayment.findFirst({
        where: {
          studentId,
          feeType: "MONTHLY",
          month,
          sessionYear,
          status: { in: ["APPROVED", "PENDING"] },
        },
      });
      if (dup) {
        return res.status(409).json({
          error: "Monthly payment already exists for this month",
          receiptNo: dup.receiptNo,
        });
      }

      const monthlyIds = cashPaymentIds();
      created.push(
        await prisma.feePayment.create({
          data: {
            studentId,
            studentEmail: student.email,
            studentName: student.name,
            studentClass,
            feeType: "MONTHLY",
            amount,
            method: "CASH",
            month,
            sessionYear,
            note,
            receiptNo: monthlyIds.receiptNo,
            gatewayTranId: monthlyIds.gatewayTranId,
            status: "APPROVED",
            submittedByStudent: false,
            recordedByAdminEmail: req.user!.email,
          },
        }),
      );

      if (payFine) {
        const snap = await monthlySnapshot(studentId, studentClass, sessionYear);
        if (snap.fineDue > 0) {
          const fineIds = cashPaymentIds();
          created.push(
            await prisma.feePayment.create({
              data: {
                studentId,
                studentEmail: student.email,
                studentName: student.name,
                studentClass,
                feeType: "FINE",
                amount: snap.fineDue,
                method: "CASH",
                month,
                sessionYear,
                note: "Monthly due fine",
                receiptNo: fineIds.receiptNo,
                gatewayTranId: fineIds.gatewayTranId,
                status: "APPROVED",
                submittedByStudent: false,
                recordedByAdminEmail: req.user!.email,
              },
            }),
          );
        }
      }
    } else {
      const catalogId = String(req.body.catalogId || "");
      if (!isObjectId(catalogId)) {
        return res.status(400).json({ error: "catalogId is required" });
      }
      const catalog = await prisma.feeCatalog.findUnique({
        where: { id: catalogId },
      });
      if (!catalog || !catalog.isActive) {
        return res.status(404).json({ error: "Catalog fee not found" });
      }
      if (source === "EXAM" && catalog.feeType !== "EXAM") {
        return res.status(400).json({ error: "This catalog item is not EXAM" });
      }

      await releaseStaleSslPending({ studentId, catalogId }, { force: true });

      const dup = await prisma.feePayment.findFirst({
        where: {
          studentId,
          catalogId,
          status: { in: ["APPROVED", "PENDING"] },
        },
      });
      if (dup) {
        return res.status(409).json({
          error: "Payment already exists for this fee",
          receiptNo: dup.receiptNo,
        });
      }

      const amount =
        Number.isFinite(Number(req.body.amount)) && Number(req.body.amount) > 0
          ? Number(req.body.amount)
          : catalog.amount;

      const ids = cashPaymentIds();
      created.push(
        await prisma.feePayment.create({
          data: {
            studentId,
            studentEmail: student.email,
            studentName: student.name,
            studentClass,
            feeType: catalog.feeType,
            amount,
            method: "CASH",
            catalogId,
            examId: catalog.examId,
            sessionYear,
            note,
            receiptNo: ids.receiptNo,
            gatewayTranId: ids.gatewayTranId,
            status: "APPROVED",
            submittedByStudent: false,
            recordedByAdminEmail: req.user!.email,
          },
        }),
      );
    }

    const snap = await refreshFeeLock(
      studentId,
      studentClass,
      sessionYear,
      req.user!.email,
    );

    return res.status(201).json({
      success: true,
      payments: created,
      blocked: snap.blocked,
    });
  } catch (err: any) {
    console.error("[fees] admin cash:", err);
    return res
      .status(500)
      .json({ error: err?.message || "Failed to record payment" });
  }
});

router.get("/admin/fees/payments", ...adminOnly, async (req, res) => {
  try {
    const sessionYear = String(
      req.query.sessionYear || new Date().getFullYear(),
    );
    const q = String(req.query.q || "").trim().toLowerCase();
    const method = String(req.query.method || "ALL");
    const studentClass = String(req.query.studentClass || "");
    const limit = Math.min(Number(req.query.limit) || 40, 100);

    const where: any = { sessionYear };
    if (studentClass && studentClass !== "All Classes") {
      where.studentClass = studentClass;
    }
    if (method === "CASH") where.method = "CASH";
    if (method === "BANK" || method === "SSL") {
      where.OR = [{ gateway: "SSLCommerz" }, { method: "BANK" }];
    }

    const payments = await prisma.feePayment.findMany({
      where,
      orderBy: { paidAt: "desc" },
      take: 200,
    });

    const filtered = q
      ? payments.filter(
          (p) =>
            p.studentName.toLowerCase().includes(q) ||
            p.studentEmail.toLowerCase().includes(q) ||
            p.receiptNo.toLowerCase().includes(q),
        )
      : payments;

    return res.json({
      success: true,
      payments: filtered.slice(0, limit).map((p) => ({
        ...p,
        methodLabel: methodLabel(p),
      })),
    });
  } catch (err: any) {
    console.error("[fees] admin payments:", err);
    return res
      .status(500)
      .json({ error: err?.message || "Failed to load payments" });
  }
});

// ── Roster ─────────────────────────────────────────────────────────────

router.get("/admin/fees/roster", ...adminOnly, async (req, res) => {
  try {
    const sessionYear = String(
      req.query.sessionYear || new Date().getFullYear(),
    );
    const studentClass = String(req.query.studentClass || "");
    const section = String(req.query.section || "");

    const where: any = { role: "student" };
    if (studentClass && studentClass !== "All Classes") {
      where.studentClass = studentClass;
    }
    if (section && section !== "All Sections") {
      where.studentSection = section;
    }

    const students = await prisma.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        email: true,
        studentClass: true,
        studentSection: true,
        feeAccessBlocked: true,
      },
      orderBy: { name: "asc" },
    });

    const rows = [];
    for (const s of students) {
      const cls = s.studentClass || "";
      const snap = await monthlySnapshot(s.id, cls, sessionYear);
      const catalogs = await prisma.feeCatalog.findMany({
        where: { sessionYear, ...catalogVisibleTo(cls, s.studentSection) },
      });
      const paidCatalog = await prisma.feePayment.findMany({
        where: {
          studentId: s.id,
          catalogId: { in: catalogs.map((c) => c.id) },
          status: "APPROVED",
        },
        select: { catalogId: true },
      });
      const paidSet = new Set(paidCatalog.map((p) => p.catalogId));
      const catalogDue = catalogs
        .filter((c) => !paidSet.has(c.id))
        .reduce((sum, c) => sum + c.amount, 0);

      rows.push({
        studentId: s.id,
        name: s.name,
        email: s.email,
        studentClass: cls,
        section: s.studentSection,
        unpaidMonths: snap.unpaidMonths.length,
        monthlyStatus: snap.unpaidMonths.includes(monthKey()) ? "DUE" : "PAID",
        fineDue: snap.fineDue,
        catalogDue,
        blocked: snap.blocked || Boolean(s.feeAccessBlocked),
      });
    }

    return res.json({ success: true, roster: rows });
  } catch (err: any) {
    console.error("[fees] roster:", err);
    return res
      .status(500)
      .json({ error: err?.message || "Failed to load roster" });
  }
});

router.post("/admin/fees/unlock/:studentId", ...adminOnly, async (req, res) => {
  try {
    const { studentId } = req.params;
    if (!isObjectId(studentId)) {
      return res.status(400).json({ error: "Invalid id" });
    }
    const sessionYear = String(
      req.body?.sessionYear || new Date().getFullYear(),
    );
    const student = await prisma.user.findUnique({ where: { id: studentId } });
    if (!student) return res.status(404).json({ error: "Student not found" });

    const snap = await refreshFeeLock(
      studentId,
      student.studentClass || "",
      sessionYear,
      req.user!.email,
    );
    if (snap.blocked) {
      return res.status(400).json({
        error: "Still more than 3 unpaid monthly months. Record cash first.",
        unpaidMonths: snap.unpaidMonths,
      });
    }
    return res.json({
      success: true,
      blocked: false,
      unpaidMonths: snap.unpaidMonths,
    });
  } catch (err: any) {
    console.error("[fees] unlock:", err);
    return res.status(500).json({ error: err?.message || "Unlock failed" });
  }
});

// ── Student dashboard ──────────────────────────────────────────────────

router.get("/student/fees", ...studentOnly, async (req, res) => {
  try {
    const student = req.user!;
    const sessionYear = String(new Date().getFullYear());
    const studentClass = student.studentClass || "";
    const month = monthKey();

    // Back dine atke thaka SSL pending gulo (5 min er purono) auto clean
    await releaseStaleSslPending(
      { studentId: student.id },
      { minAgeMs: 5 * 60 * 1000 },
    );

    const snap = await monthlySnapshot(student.id, studentClass, sessionYear);
    await refreshFeeLock(student.id, studentClass, sessionYear);

    const thisMonthPaid = !snap.unpaidMonths.includes(month);
    const catalogs = await prisma.feeCatalog.findMany({
      where: {
        sessionYear,
        ...catalogVisibleTo(studentClass, student.studentSection),
      },
      orderBy: { createdAt: "desc" },
    });

    const catalogPays = await prisma.feePayment.findMany({
      where: {
        studentId: student.id,
        catalogId: { in: catalogs.map((c) => c.id) },
        status: { in: ["APPROVED", "PENDING"] },
      },
    });
    const catalogPayMap = new Map(catalogPays.map((p) => [p.catalogId, p]));

    const history = await prisma.feePayment.findMany({
      where: { studentId: student.id, status: "APPROVED" },
      orderBy: { paidAt: "desc" },
      take: 50,
    });
    const pending = await prisma.feePayment.findMany({
      where: {
        studentId: student.id,
        OR: [{ status: "PENDING" }, { gatewayStatus: "PENDING" }],
      },
      orderBy: { paidAt: "desc" },
    });

    return res.json({
      success: true,
      blocked: snap.blocked,
      monthly: {
        month,
        amount: snap.rate,
        paid: thisMonthPaid ? snap.rate : 0,
        due: thisMonthPaid ? 0 : snap.rate,
        status: thisMonthPaid ? "PAID" : "DUE",
      },
      unpaidMonths: snap.unpaidMonths,
      fine: {
        applicable: snap.fineApplicable,
        amount: snap.settings.fineAmount,
        paid: snap.finePaid,
        due: snap.fineDue,
      },
      catalog: catalogs.map((c) => {
        const pay = catalogPayMap.get(c.id);
        const paid = pay?.status === "APPROVED";
        return {
          id: c.id,
          title: c.title,
          description: c.description,
          feeType: c.feeType,
          amount: c.amount,
          dueDate: c.dueDate,
          status: paid ? "PAID" : pay ? "PENDING" : "DUE",
        };
      }),
      pending,
      history: history.map((p) => ({ ...p, methodLabel: methodLabel(p) })),
    });
  } catch (err: any) {
    console.error("[fees] student get:", err);
    return res
      .status(500)
      .json({ error: err?.message || "Failed to load fees" });
  }
});

// ── SSLCommerz ─────────────────────────────────────────────────────────

router.post("/student/fees/ssl/init", ...studentOnly, async (req, res) => {
  try {
    const student = req.user!;
    const sessionYear = String(
      req.body.sessionYear || new Date().getFullYear(),
    );
    const feeType = String(req.body.feeType || "MONTHLY") as FeeType;
    const studentClass = student.studentClass || "";

    // NOTE: blocked student ke-o pay korte dite hobe, na hole kokhono unblock hobe na.
    // Lock shudhu baki feature access ar jonno, payment er jonno na.
    const snap = await monthlySnapshot(student.id, studentClass, sessionYear);

    let amount = 0;
    let baseAmount = 0;
    let month: string | null = null;
    let catalogId: string | null = null;
    let examId: string | null = null;
    let productName = "School fee";
    let payNote: string | null = null;

    if (feeType === "MONTHLY") {
      // month na pathale shobcheye purono unpaid month (age current month chhilo,
      // tai purono beton kokhono pay kora jeto na)
      const requestedMonth = req.body.month ? String(req.body.month) : null;
      month = requestedMonth || snap.unpaidMonths[0] || null;
      if (!month) {
        return res.status(400).json({ error: "No unpaid month found" });
      }
      if (!snap.unpaidMonths.includes(month)) {
        return res
          .status(400)
          .json({ error: "This month is already paid or outside the session" });
      }
      if (!snap.rate) {
        return res.status(400).json({ error: "Monthly rate not set" });
      }

      // Back dewar karone atke thaka SSL pending clear / verify kori
      await releaseStaleSslPending(
        { studentId: student.id, feeType: "MONTHLY", month, sessionYear },
        { force: true },
      );

      const dup = await prisma.feePayment.findFirst({
        where: {
          studentId: student.id,
          feeType: "MONTHLY",
          month,
          sessionYear,
          status: { in: ["APPROVED", "PENDING"] },
        },
      });
      if (dup) {
        return res
          .status(409)
          .json({ error: "Already paid / pending for this month" });
      }

      baseAmount = snap.rate;
      amount = snap.rate + snap.fineDue; // gateway theke total charge hobe
      productName = `Monthly fee ${month}`;
      // Fine alada FINE row hishebe payment success e toiri hobe
      if (snap.fineDue > 0) payNote = `${FINE_MARK}${snap.fineDue}`;
    } else {
      catalogId = String(req.body.catalogId || "");
      if (!isObjectId(catalogId)) {
        return res.status(400).json({ error: "catalogId required" });
      }
      const catalog = await prisma.feeCatalog.findUnique({
        where: { id: catalogId },
      });
      if (!catalog || !catalog.isActive) {
        return res.status(404).json({ error: "Fee not found" });
      }

      await releaseStaleSslPending(
        { studentId: student.id, catalogId },
        { force: true },
      );

      const dup = await prisma.feePayment.findFirst({
        where: {
          studentId: student.id,
          catalogId,
          status: { in: ["APPROVED", "PENDING"] },
        },
      });
      if (dup) return res.status(409).json({ error: "Already paid / pending" });
      baseAmount = catalog.amount;
      amount = catalog.amount;
      examId = catalog.examId;
      productName = catalog.title;
    }

    let gatewayTranId = uniqueTranId();
    let taken = await prisma.feePayment.findFirst({ where: { gatewayTranId } });
    while (taken) {
      gatewayTranId = uniqueTranId();
      taken = await prisma.feePayment.findFirst({ where: { gatewayTranId } });
    }

    const payment = await prisma.feePayment.create({
      data: {
        studentId: student.id,
        studentEmail: student.email,
        studentName: student.name,
        studentClass,
        feeType,
        amount: baseAmount, // fine bade, fine alada row e jabe
        method: "BANK",
        month,
        catalogId,
        examId,
        sessionYear,
        note: payNote,
        receiptNo: receiptNo(),
        status: "PENDING",
        submittedByStudent: true,
        gateway: "SSLCommerz",
        gatewayStatus: "PENDING",
        gatewayTranId,
        gatewayAmount: amount, // gateway te jeta charge hocche (fine soho)
        transactionRef: gatewayTranId,
      },
    });

    const apiResponse = await getSsl().init({
      total_amount: amount,
      currency: "BDT",
      tran_id: gatewayTranId,
      success_url: `${serverUrl()}/api/student/fees/ssl/success`,
      fail_url: `${serverUrl()}/api/student/fees/ssl/fail`,
      cancel_url: `${serverUrl()}/api/student/fees/ssl/cancel`,
      ipn_url: `${serverUrl()}/api/student/fees/ssl/ipn`,
      shipping_method: "NO",
      product_name: productName,
      product_category: "Education",
      product_profile: "general",
      cus_name: student.name,
      cus_email: student.email,
      cus_add1: "Dhaka",
      cus_city: "Dhaka",
      cus_country: "Bangladesh",
      cus_phone: (student as any).phone || "01700000000",
    });

    if (!apiResponse?.GatewayPageURL) {
      await prisma.feePayment.update({
        where: { id: payment.id },
        data: { gatewayStatus: "FAILED", status: "REJECTED" },
      });
      return res.status(400).json({
        error: apiResponse?.failedreason || "Failed to start payment",
      });
    }

    return res.json({
      success: true,
      url: apiResponse.GatewayPageURL,
      tranId: gatewayTranId,
      paymentId: payment.id,
    });
  } catch (err: any) {
    console.error("[ssl] init:", err);
    return res.status(500).json({ error: err?.message || "Init failed" });
  }
});

// Student nijei atke thaka pending cancel korte parbe (frontend "Cancel" button)
router.post(
  "/student/fees/ssl/cancel-pending",
  ...studentOnly,
  async (req, res) => {
    try {
      const student = req.user!;
      const paymentId = String(req.body.paymentId || "");
      if (!isObjectId(paymentId)) {
        return res.status(400).json({ error: "Valid paymentId required" });
      }

      const payment = await prisma.feePayment.findFirst({
        where: { id: paymentId, studentId: student.id },
      });
      if (!payment) return res.status(404).json({ error: "Payment not found" });

      await releaseStaleSslPending(
        { id: paymentId, studentId: student.id },
        { force: true },
      );

      const after = await prisma.feePayment.findUnique({
        where: { id: paymentId },
      });
      return res.json({
        success: true,
        status: after?.status,
        gatewayStatus: after?.gatewayStatus,
      });
    } catch (err: any) {
      console.error("[ssl] cancel-pending:", err);
      return res.status(500).json({ error: err?.message || "Cancel failed" });
    }
  },
);

router.post("/student/fees/ssl/success", async (req, res) => {
  try {
    const tranId = String(req.body.tran_id || "");
    const valId = String(req.body.val_id || "");
    await markSslPaid(tranId, valId);
    return res.redirect(
      `${clientUrl()}/dashboard/student/fee?status=success&tran=${encodeURIComponent(tranId)}`,
    );
  } catch (e) {
    console.error("[ssl] success:", e);
    return res.redirect(`${clientUrl()}/dashboard/student/fee?status=error`);
  }
});

router.post("/student/fees/ssl/fail", async (req, res) => {
  await markSslClosed(String(req.body.tran_id || ""), "FAILED");
  return res.redirect(`${clientUrl()}/dashboard/student/fee?status=fail`);
});

router.post("/student/fees/ssl/cancel", async (req, res) => {
  await markSslClosed(String(req.body.tran_id || ""), "CANCELLED");
  return res.redirect(`${clientUrl()}/dashboard/student/fee?status=cancel`);
});

router.post("/student/fees/ssl/ipn", async (req, res) => {
  try {
    const tranId = String(req.body.tran_id || "");
    const valId = String(req.body.val_id || "");
    const status = String(req.body.status || "").toUpperCase();
    if (status === "VALID" || status === "VALIDATED") {
      await markSslPaid(tranId, valId);
    } else if (status === "FAILED") {
      await markSslClosed(tranId, "FAILED");
    } else if (status === "CANCELLED") {
      await markSslClosed(tranId, "CANCELLED");
    }
    return res.status(200).send("OK");
  } catch (e) {
    console.error("[ssl] ipn:", e);
    return res.status(500).send("ERROR");
  }
});

export default router;