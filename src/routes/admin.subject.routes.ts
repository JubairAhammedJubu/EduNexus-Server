import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/session.js";
import { prisma } from "../lib/prisma.js";

export const router = Router();
export const adminOnly = [requireAuth, requireRole("admin")] as const;

// ── Subject catalog ──────────────────────────────────────────────────────

// GET /api/admin/subjects?groupId=
router.get("/admin/subjects", ...adminOnly, async (req, res) => {
  try {
    const { groupId } = req.query as Record<string, string>;
    const subjects = await prisma.subject.findMany({
      where: {
        isActive: true,
        ...(groupId ? { OR: [{ groupId }, { isCore: true }] } : {}),
      },
      include: { group: true },
      orderBy: { name: "asc" },
    });
    res.json({ subjects });
  } catch (err: any) {
    console.error("[subjects] list:", err);
    res.status(500).json({ error: err?.message || "Failed to load subjects" });
  }
});

// POST /api/admin/subjects
// Body: { name, code, groupId?, isCore? }
router.post("/admin/subjects", ...adminOnly, async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const code = String(req.body.code || "")
      .trim()
      .toUpperCase();
    const groupId = req.body.groupId || null;
    const isCore = groupId ? false : req.body.isCore !== false;

    if (!name || !code) {
      return res.status(400).json({ error: "name and code are required" });
    }

    const subject = await prisma.subject.create({
      data: { name, code, groupId, isCore },
    });

    res.status(201).json({ subject });
  } catch (err: any) {
    if (err.code === "P2002") {
      return res
        .status(409)
        .json({ error: "This subject already exists for this group" });
    }
    console.error("[subjects] create:", err);
    res.status(500).json({ error: err?.message || "Failed to create subject" });
  }
});

// POST /api/admin/subjects/seed-bd-curriculum
router.post("/admin/subjects/seed-bd-curriculum", ...adminOnly, async (req, res) => {
  try {
    // 1. Ensure the three academic groups exist
    const groupNames = ["Science", "Business Studies", "Humanities"];
    const groups: Record<string, string> = {};

    for (let i = 0; i < groupNames.length; i++) {
      const name = groupNames[i];
      let group = await prisma.academicGroup.findUnique({ where: { name } });
      if (!group) {
        group = await prisma.academicGroup.create({ data: { name, order: i } });
      }
      groups[name] = group.id;
    }

    // 2. Core subjects — every student, Class 6–10
    const coreSubjects = [
      { name: "Bangla First Paper", code: "BAN1" },
      { name: "Bangla Second Paper", code: "BAN2" },
      { name: "English First Paper", code: "ENG1" },
      { name: "English Second Paper", code: "ENG2" },
      { name: "Mathematics", code: "MATH" },
      { name: "Information and Communication Technology", code: "ICT" },
      { name: "Religion & Moral Education", code: "REL" },
      { name: "Physical Education & Health", code: "PEH" },
      { name: "Bangladesh and Global Studies", code: "BGS" },
      { name: "Science", code: "SCI" },
      { name: "Career Education", code: "CE" },
    ];

    // 3. Group-specific subjects — Class 9/10 only
    const groupSubjects = [
      // Science
      { name: "Physics", code: "PHY", group: "Science" },
      { name: "Chemistry", code: "CHE", group: "Science" },
      { name: "Biology", code: "BIO", group: "Science" },
      { name: "Higher Mathematics", code: "HMATH", group: "Science" },
      // Business Studies
      { name: "Accounting", code: "ACC", group: "Business Studies" },
      { name: "Finance & Banking", code: "FIN", group: "Business Studies" },
      { name: "Business Entrepreneurship", code: "BE", group: "Business Studies" },
      // Humanities
      { name: "Civics & Citizenship", code: "CIV", group: "Humanities" },
      { name: "Economics", code: "ECO", group: "Humanities" },
      { name: "History of Bangladesh & World Civilization", code: "HIS", group: "Humanities" },
      { name: "Geography & Environment", code: "GEO", group: "Humanities" },
    ];

    const created: string[] = [];
    const skipped: string[] = [];

    for (const s of coreSubjects) {
      const existing = await prisma.subject.findFirst({ where: { name: s.name, groupId: null } });
      if (existing) {
        skipped.push(s.name);
        continue;
      }
      await prisma.subject.create({ data: { name: s.name, code: s.code, isCore: true } });
      created.push(s.name);
    }

    for (const s of groupSubjects) {
      const groupId = groups[s.group];
      const existing = await prisma.subject.findFirst({ where: { name: s.name, groupId } });
      if (existing) {
        skipped.push(s.name);
        continue;
      }
      await prisma.subject.create({ data: { name: s.name, code: s.code, groupId, isCore: false } });
      created.push(s.name);
    }

    res.json({
      message: `Seeded ${created.length} subjects (${skipped.length} already existed)`,
      created,
      skipped,
    });
  } catch (err: any) {
    console.error("[subjects] seed BD curriculum:", err);
    res.status(500).json({ error: err?.message || "Seed failed" });
  }
});

// DELETE /api/admin/subjects/:id
router.delete("/admin/subjects/:id", ...adminOnly, async (req, res) => {
  try {
    const inUse = await prisma.classSubject.findFirst({
      where: { subjectId: req.params.id },
    });
    if (inUse) {
      return res
        .status(409)
        .json({
          error:
            "This subject is assigned to a class section — remove it there first",
        });
    }
    await prisma.subject.delete({ where: { id: req.params.id } });
    res.json({ message: "Subject removed" });
  } catch (err: any) {
    console.error("[subjects] delete:", err);
    res.status(500).json({ error: err?.message || "Failed to remove subject" });
  }
});
export default router;