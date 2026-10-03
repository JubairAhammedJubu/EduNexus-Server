import nodemailer from "nodemailer";

// ── Email transport (forgot-password link) ─────────────────────────
// Here we are using generic SMTP (Gmail app-password, Mailtrap,
// Brevo, or any SMTP provider) — no third-party services like Resend/SES
// required, just SMTP credentials.
const smtpPort = Number(process.env.SMTP_PORT ?? 587);

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: smtpPort,
  // Port 465 is implicit TLS; all other ports (587, 25...) use STARTTLS.
  secure: smtpPort === 465,
  auth: process.env.SMTP_USER
    ? {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      }
    : undefined,
});

const FROM_ADDRESS =
  process.env.SMTP_FROM || "EduNexus <no-reply@edunexus.local>";

/**
 * Password-reset link email (factor 1: user must have access to their
 * institution inbox). The link takes them to the frontend's
 * /reset-password page, where factor 2 (their authenticator app's
 * 6-digit code) is required before the password actually changes.
 */
export async function sendPasswordResetEmail(params: {
  to: string;
  name: string;
  url: string;
}) {
  const { to, name, url } = params;

  if (!process.env.SMTP_HOST) {
    // If SMTP is not configured (e.g. local dev), log the link in the
    // console so testing can be done without sending emails.
    console.warn(
      `[mailer] SMTP_HOST is not set — reset link printed to console:\n${url}`,
    );
    return;
  }

  await transporter.sendMail({
    from: FROM_ADDRESS,
    to,
    subject: "Reset your EduNexus password",
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #1e293b;">Reset your password</h2>
        <p style="color: #475569; font-size: 14px; line-height: 1.6;">
          Hi ${name || "there"},<br /><br />
          We received a request to reset the password for your EduNexus account.
          Click the button below to choose a new one. You'll also need the
          6-digit code from your authenticator app to finish resetting it.
        </p>
        <p style="margin: 24px 0;">
          <a href="${url}"
             style="background: #2563eb; color: #fff; padding: 10px 20px;
                    border-radius: 8px; text-decoration: none; font-weight: 600;
                    font-size: 14px;">
            Reset Password
          </a>
        </p>
        <p style="color: #94a3b8; font-size: 12px;">
          This link expires in 15 minutes. If you didn't request this,
          you can safely ignore this email — your password won't be changed.
        </p>
      </div>
    `,
  });
}
