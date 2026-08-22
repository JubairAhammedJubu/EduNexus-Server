import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/session.js";

const router = Router();

// GET /api/me — any logged-in user (admin, teacher, or student).
router.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// GET /api/admin/overview — admin-only example.
router.get("/admin/overview", requireAuth, requireRole("admin"), (req, res) => {
  res.json({ message: `Welcome, admin ${req.user?.name ?? ""}` });
});

export default router;
