import { Router } from "express";
import crypto from "crypto";
import { symmetricDecrypt, hashPassword } from "better-auth/crypto";
import { createOTP } from "@better-auth/utils/otp";
import { prisma } from "../lib/prisma.js";

const router = Router();

// Better Auth encrypts every stored TOTP secret with this same key (see
// `secret`/`secretConfig` in src/lib/auth.ts — since we don't configure a
// `secrets` rotation array there, secretConfig is just this string).
const AUTH_SECRET =
  process.env.BETTER_AUTH_SECRET || "better-auth-secret-12345678901234567890";

// ── "Forgot password" via authenticator app ─────────────────────────
// Kono email/OTP pathano hoy na — user tar email + tar authenticator app
// er 6-digit code dey (jei TOTP secret ta already 2FA login-e use hoy),
// shothik hole ekta short-lived resetToken pai, tarpor shei token diye
// notun password set kore. Token gulo memory-te thake (DB migration
// lagena) — 5 minute-e expire, ar ekbar use korle shathe shathe delete.
const resetTickets = new Map<string, { email: string; expiresAt: number }>();

function cleanupExpiredTickets() {
  const now = Date.now();
  for (const [token, ticket] of resetTickets) {
    if (ticket.expiresAt <= now) resetTickets.delete(token);
  }
}

/**
 * POST /api/password-reset/verify-code
 * Step 1: email + authenticator (TOTP) code in, resetToken out (only if
 * the code actually matches that account's 2FA secret).
 */
router.post("/password-reset/verify-code", async (req, res) => {
  try {
    const email = (req.body?.email as string | undefined)?.toLowerCase().trim();
    const code = (req.body?.code as string | undefined)?.trim();

    if (!email || !code) {
      return res
        .status(400)
        .json({ error: "Email and authenticator code are required." });
    }

    // Same message whether the email doesn't exist or 2FA isn't set up —
    // don't reveal which one it is.
    const genericError =
      "Could not verify that email and code. Please check both and try again.";

    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, twoFactorEnabled: true },
    });
    if (!user || !user.twoFactorEnabled) {
      return res.status(400).json({ error: genericError });
    }

    const twoFactor = await prisma.twoFactor.findFirst({
      where: { userId: user.id },
      select: { secret: true },
    });
    if (!twoFactor) {
      return res.status(400).json({ error: genericError });
    }

    const secret = await symmetricDecrypt({
      key: AUTH_SECRET,
      data: twoFactor.secret,
    });
    const isValid = await createOTP(secret, { digits: 6, period: 30 }).verify(
      code,
    );

    if (!isValid) {
      return res
        .status(400)
        .json({ error: "Incorrect authenticator code. Please try again." });
    }

    cleanupExpiredTickets();
    const resetToken = crypto.randomBytes(32).toString("hex");
    resetTickets.set(resetToken, {
      email,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    return res.json({ success: true, resetToken });
  } catch (error: any) {
    console.error("Error verifying password-reset code:", error);
    return res
      .status(500)
      .json({ error: error?.message || "Something went wrong. Please try again." });
  }
});

/**
 * POST /api/password-reset/set-password
 * Step 2: spend the resetToken from step 1 to actually set a new password.
 */
router.post("/password-reset/set-password", async (req, res) => {
  try {
    const resetToken = (req.body?.resetToken as string | undefined)?.trim();
    const newPassword = (req.body?.newPassword as string | undefined) ?? "";

    if (!resetToken || !newPassword) {
      return res
        .status(400)
        .json({ error: "Reset token and new password are required." });
    }
    if (newPassword.length < 8) {
      return res
        .status(400)
        .json({ error: "Password must be at least 8 characters." });
    }

    cleanupExpiredTickets();
    const ticket = resetTickets.get(resetToken);
    if (!ticket) {
      return res
        .status(400)
        .json({ error: "This reset session has expired. Please start over." });
    }
    resetTickets.delete(resetToken); // single-use

    const user = await prisma.user.findUnique({
      where: { email: ticket.email },
      select: { id: true },
    });
    if (!user) {
      return res.status(400).json({ error: "Account not found." });
    }

    const passwordHash = await hashPassword(newPassword);
    const existingAccount = await prisma.account.findFirst({
      where: { userId: user.id, providerId: "credential" },
    });

    if (existingAccount) {
      await prisma.account.update({
        where: { id: existingAccount.id },
        data: { password: passwordHash },
      });
    } else {
      await prisma.account.create({
        data: {
          userId: user.id,
          providerId: "credential",
          accountId: user.id,
          password: passwordHash,
        },
      });
    }

    return res.json({ success: true, message: "Password updated successfully." });
  } catch (error: any) {
    console.error("Error setting new password:", error);
    return res
      .status(500)
      .json({ error: error?.message || "Something went wrong. Please try again." });
  }
});

export default router;
