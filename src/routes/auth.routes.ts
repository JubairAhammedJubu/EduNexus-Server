import { Router } from "express";
import { toNodeHandler } from "better-auth/node";
import { auth } from "../lib/auth.js";

const router = Router();

// Handles /api/auth/sign-up/email, /api/auth/sign-in/email,
// /api/auth/sign-out, /api/auth/get-session, etc. — every route Better
// Auth defines. Must be mounted BEFORE express.json() for this path,
// since Better Auth parses the raw request body itself.
router.all("/*", toNodeHandler(auth));

export default router;
