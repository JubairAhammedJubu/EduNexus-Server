import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/session.js";
import { prisma } from "../lib/prisma.js";

const router = Router();

/**
 * GET /api/approval-status?email=...
 * Public — the login page polls this (no session exists yet) to decide
 * whether to show a disabled "Pending approval" button. Unknown emails
 * report isApproved: true on purpose, so a mistyped/nonexistent email
 * never gets treated as "pending" — the actual sign-in call is what
 * reports a real invalid-credentials error.
 */
router.get("/approval-status", async (req, res) => {
  try {
    const email = (req.query.email as string | undefined)?.toLowerCase().trim();
    if (!email) {
      return res.status(400).json({ error: "Email is required." });
    }

    const user = await prisma.user.findUnique({
      where: { email },
      select: { isApproved: true },
    });

    return res.json({ isApproved: user ? user.isApproved : true });
  } catch (error: any) {
    console.error("Error checking approval status:", error);
    return res
      .status(500)
      .json({ error: error?.message || "Something went wrong. Please try again." });
  }
});

/**
 * GET /api/admin/pending-users
 * Admin only — everyone currently waiting on approval.
 */
router.get(
  "/admin/pending-users",
  requireAuth,
  requireRole("admin"),
  async (_req, res) => {
    try {
      const pendingUsers = await prisma.user.findMany({
        where: { isApproved: false },
        select: { id: true, name: true, email: true, role: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      });
      return res.json({ users: pendingUsers });
    } catch (error: any) {
      console.error("Error listing pending users:", error);
      return res
        .status(500)
        .json({ error: error?.message || "Something went wrong. Please try again." });
    }
  },
);

/**
 * POST /api/admin/approve-user
 * Admin only — approve one pending user by id.
 */
router.post(
  "/admin/approve-user",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    try {
      const userId = (req.body?.userId as string | undefined)?.trim();
      if (!userId) {
        return res.status(400).json({ error: "userId is required." });
      }

      const user = await prisma.user.update({
        where: { id: userId },
        data: { isApproved: true },
        select: { id: true, name: true, email: true },
      });

      return res.json({ success: true, message: `${user.name} approved.`, user });
    } catch (error: any) {
      console.error("Error approving user:", error);
      return res
        .status(500)
        .json({ error: error?.message || "Could not approve that user." });
    }
  },
);

export default router;
