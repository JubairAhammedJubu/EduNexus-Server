import type { NextFunction, Request, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../lib/auth.js";

// Augment Express's Request so downstream handlers get typed access to
// the authenticated user/session without re-fetching it.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
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
 * Verifies the Better Auth session cookie on the incoming request and
 * attaches `req.user` / `req.session`. Responds with 401 if there is no
 * valid session — use this to protect any route that requires login.
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
    return res.status(401).json({ error: "Not authenticated" });
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
      return res.status(403).json({ error: "Forbidden" });
    }

    next();
  };
}
