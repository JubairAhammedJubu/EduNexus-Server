import type { NextFunction, Request, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../lib/auth.js";

declare global {
  namespace Express {
    interface Request {
      user?: Awaited<ReturnType<typeof auth.api.getSession>> extends infer S
        ? S extends { user: infer U }
          ? U
          : never
        : never;
      session?: Awaited<ReturnType<typeof auth.api.getSession>> extends infer S
        ? S extends { session: infer Sess }
          ? Sess
          : never
        : never;
    }
  }
}

/**
 * Verifies the Better Auth session via Cookie OR Authorization Header (Bearer Token)
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const result = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });

  if (!result) {
    return res.status(401).json({ status: false, code: 401, error: "Unauthorized" });
  }

  req.user = result.user;
  req.session = result.session;
  next();
}

/**
 * Role-gate for admin / teacher / student routes. Use after requireAuth:
 *   router.get("/admin/reports", requireAuth, requireRole("admin"), handler)
 */
export function requireRole(...allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const role = (req.user as { role?: string } | undefined)?.role;

    if (!role || !allowedRoles.includes(role)) {
      return res.status(403).json({ status: false, code: 403, error: "Forbidden" });
    }

    next();
  };
}