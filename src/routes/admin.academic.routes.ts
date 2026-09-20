
import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/session.js";
import { prisma } from "../lib/prisma.js";

export const router = Router();
export const adminOnly = [requireAuth, requireRole("admin")] as const;
// GET /api/admin/academic-groups
router.get("/admin/academic-groups", ...adminOnly, async (req, res) => {
  try {
    const groups = await prisma.academicGroup.findMany({
      where: { isActive: true },
      orderBy: { order: "asc" },
    });
    res.json({ groups });
  } catch (err: any) {
    console.error("[groups] list:", err);
    res.status(500).json({ error: err?.message || "Failed to load groups" });
  }
});

// POST /api/admin/academic-groups
// Body: { name, order? }
router.post("/admin/academic-groups", ...adminOnly, async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    if (!name) {
      return res.status(400).json({ error: "Group name is required" });
    }
    const group = await prisma.academicGroup.create({
      data: { name, order: Number(req.body.order) || 0 },
    });
    res.status(201).json({ group });
  } catch (err: any) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "This group already exists" });
    }
    console.error("[groups] create:", err);
    res.status(500).json({ error: err?.message || "Failed to create group" });
  }
});

export default router;