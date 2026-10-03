import { Router } from "express";
import crypto from "crypto";
import { symmetricDecrypt, hashPassword } from "better-auth/crypto";
import { createOTP } from "@better-auth/utils/otp";
import { prisma } from "../lib/prisma.js";

const router = Router();

// Better Auth encrypts every stored TOTP secret with this same key (see
// `secret`/`secretConfig` in src/lib/auth.ts — since we don't configure a
// `secrets` rotation array there, secretConfig is just this string).
const AUTH_SECRET = process.env.BETTER_AUTH_SECRET;

// ── "Forgot password" via authenticator app ─────────────────────────
// No email/OTP is sent — user provides their email + their authenticator app
// 6-digit code (the TOTP secret already used for 2FA login). If valid,
// a short-lived resetToken is returned, which is then used to set a new password.
const MAX_RESET_CODE_ATTEMPTS = 5;
const RESET_LOCK_DURATION_MS = 15 * 60 * 1000;

function hashResetToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
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
      select: {
        id: true,
        twoFactorEnabled: true,
        passwordResetFailedAttempts: true,
        passwordResetLockedUntil: true,
      },
    });
    if (!user || !user.twoFactorEnabled) {
      return res.status(400).json({ error: genericError });
    }

    if (
      user.passwordResetLockedUntil &&
      user.passwordResetLockedUntil.getTime() > Date.now()
    ) {
      return res.status(429).json({ error: genericError });
    }

    if (user.passwordResetLockedUntil) {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          passwordResetFailedAttempts: 0,
          passwordResetLockedUntil: null,
        },
      });
    }

    if (!AUTH_SECRET) throw new Error("BETTER_AUTH_SECRET is not configured");

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
      const updated = await prisma.user.update({
        where: { id: user.id },
        data: { passwordResetFailedAttempts: { increment: 1 } },
        select: { passwordResetFailedAttempts: true },
      });
      if (updated.passwordResetFailedAttempts >= MAX_RESET_CODE_ATTEMPTS) {
        await prisma.user.update({
          where: { id: user.id },
          data: {
            passwordResetLockedUntil: new Date(
              Date.now() + RESET_LOCK_DURATION_MS,
            ),
          },
        });
      }
      return res.status(400).json({ error: genericError });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordResetFailedAttempts: 0, passwordResetLockedUntil: null },
    });
    await prisma.passwordResetTicket.deleteMany({
      where: { expiresAt: { lte: new Date() } },
    });
    const resetToken = crypto.randomBytes(32).toString("hex");
    await prisma.passwordResetTicket.create({
      data: {
        tokenHash: hashResetToken(resetToken),
        email,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      },
    });

    return res.json({ success: true, resetToken });
  } catch (error: any) {
    console.error("Error verifying password-reset code:", error);
    return res.status(500).json({
      error: error?.message || "Something went wrong. Please try again.",
    });
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

    const tokenHash = hashResetToken(resetToken);
    const ticket = await prisma.passwordResetTicket.findUnique({
      where: { tokenHash },
    });
    if (!ticket || ticket.expiresAt.getTime() <= Date.now()) {
      if (ticket) {
        await prisma.passwordResetTicket.deleteMany({ where: { tokenHash } });
      }
      return res
        .status(400)
        .json({ error: "This reset session has expired. Please start over." });
    }

    const claimed = await prisma.passwordResetTicket.deleteMany({
      where: { tokenHash, expiresAt: { gt: new Date() } },
    });
    if (claimed.count !== 1) {
      return res
        .status(400)
        .json({ error: "This reset session has expired. Please start over." });
    }

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

    await prisma.session.deleteMany({ where: { userId: user.id } });

    return res.json({
      success: true,
      message: "Password updated successfully.",
    });
  } catch (error: any) {
    console.error("Error setting new password:", error);
    return res.status(500).json({
      error: error?.message || "Something went wrong. Please try again.",
    });
  }
});

export default router;
