import { betterAuth } from "better-auth";
import { twoFactor } from "better-auth/plugins";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { hashPassword } from "better-auth/crypto";
import { prisma } from "./prisma.js";

// ── Login lockout policy ───────────────────────────────────────────
// If a user enters an incorrect password 3 times, their account will be
// locked for 5 hours.
const MAX_FAILED_LOGIN_ATTEMPTS = 3;
const LOCKOUT_DURATION_MS = 5 * 60 * 60 * 1000; // 5 hours

export function isDemoEmail(email: string): boolean {
  const normalized = email.toLowerCase().trim();
  return (
    normalized === "demostudent@edunexus.std.com" ||
    normalized === "demoteacher@edunexus.tchr.com"
  );
}

async function handleDemoUserSignIn(email: string) {
  const isTeacher = email.endsWith("@edunexus.tchr.com");
  const defaultPassword = isTeacher ? "demoteacher1234" : "demostudent1234";
  const passwordHash = await hashPassword(defaultPassword);

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, isApproved: true, twoFactorEnabled: true, lockedUntil: true },
  });

  if (!user) {
    const created = await prisma.user.create({
      data: {
        name: isTeacher ? "Demo Teacher" : "Demo Student",
        email,
        role: isTeacher ? "teacher" : "student",
        isApproved: true,
        twoFactorEnabled: false,
        emailVerified: true,
      },
    });

    await prisma.account.create({
      data: {
        userId: created.id,
        accountId: created.id,
        providerId: "credential",
        password: passwordHash,
      },
    });
  } else {
    await prisma.user.update({
      where: { email },
      data: {
        isApproved: true,
        twoFactorEnabled: false,
        lockedUntil: null,
        failedLoginAttempts: 0,
      },
    });

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
          accountId: user.id,
          providerId: "credential",
          password: passwordHash,
        },
      });
    }

    await prisma.twoFactor.deleteMany({
      where: { userId: user.id },
    });
  }
}

function formatRemainingLockTime(lockedUntil: Date): string {
  const msLeft = lockedUntil.getTime() - Date.now();
  const minutesLeft = Math.max(1, Math.ceil(msLeft / 60000));
  if (minutesLeft < 60) {
    return `${minutesLeft} minute${minutesLeft === 1 ? "" : "s"}`;
  }
  const hoursLeft = Math.ceil(minutesLeft / 60);
  return `${hoursLeft} hour${hoursLeft === 1 ? "" : "s"}`;
}

const clientOrigins = [
  "http://localhost:3000",
  "http://localhost:5000",
  ...(process.env.CLIENT_ORIGIN ? process.env.CLIENT_ORIGIN.split(",").map((origin) => origin.trim()) : []),
].filter(Boolean);

const isProduction =
  process.env.NODE_ENV === "production" ||
  (process.env.BETTER_AUTH_URL?.startsWith("https://") ?? false);

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:5000",
  secret: process.env.BETTER_AUTH_SECRET,
  basePath: "/api/auth",
  trustedOrigins: clientOrigins,

  plugins: [
    // Authenticator-app (TOTP) 2FA. First successful email+password login
    // (before `user.twoFactorEnabled`) lets the client call
    // `twoFactor.enable` to get a QR code; every login after that goes
    // through the `twoFactorRedirect` + `verify-totp` flow automatically.
    twoFactor({
      issuer: "EduNexus",
    }),
  ],

  database: prismaAdapter(prisma, {
    provider: "mongodb",
  }),

  advanced: {
    database: { generateId: false },
    useSecureCookies: isProduction,
    defaultCookieAttributes: {
      sameSite: isProduction ? "none" : "lax",
      secure: isProduction,
    },
  },

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    // After registration, the account remains in pending-approval state, so
    // we do not automatically sign in — the user is redirected to the login form
    // and must log in normally after admin approval.
    autoSignIn: false,
  },

  user: {
    additionalFields: {
      role: {
        type: ["admin", "teacher", "student"],
        required: false,
        defaultValue: "student",
        input: false, // cannot be passed from client
      },
      phone: {
        type: "string",
        required: false,
      },
      location: {
        type: "string",
        required: false,
      },
      department: {
        type: "string",
        required: false,
      },
      bio: {
        type: "string",
        required: false,
      },
      fatherName: {
        type: "string",
        required: false,
      },
      motherName: {
        type: "string",
        required: false,
      },
      dateOfBirth: {
        type: "string",
        required: false,
      },
      address: {
        type: "string",
        required: false,
      },
      bloodGroup: {
        type: "string",
        required: false,
      },
      gender: {
        type: "string",
        required: false,
      },
      guardianPhone: {
        type: "string",
        required: false,
      },
      guardianRelation: {
        type: "string",
        required: false,
      },
      schoolName: {
        type: "string",
        required: false,
      },
      studentClass: {
        type: "string",
        required: false,
      },
      studentSection: {
        type: "string",
        required: false,
      },
      sessionYear: {
        type: "string",
        required: false,
      },
      group: {
        type: "string",
        required: false,
      },
      roll: {
        type: "string",
        required: false,
      },
      qualification: {
        type: "string",
        required: false,
      },
      // NOTE: better-auth's internal field-transform step only keeps
      // fields declared here — anything else in a databaseHooks return
      // value gets silently dropped before it ever reaches Prisma. This
      // MUST be declared for the isApproved:false override (see
      // databaseHooks.user.create.before below) to actually persist.
      isApproved: {
        type: "boolean",
        required: false,
        defaultValue: true,
        input: false, // cannot be set from client — only changed via admin approve endpoint
      },
    },
  },

  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          const email = user.email?.toLowerCase() ?? "";
          console.log("HOOK CHECKING EMAIL:", email);

          let role: "teacher" | "student";
          if (email.endsWith("@edunexus.std.com")) {
            role = "student";
          } else if (email.endsWith("@edunexus.tchr.com")) {
            role = "teacher";
          } else {
            // Reject registration if not an institution email
            throw new APIError("BAD_REQUEST", {
              message:
                "Not an institution email. Use your @edunexus.std.com or @edunexus.tchr.com address to register.",
              code: "NOT_INSTITUTION_EMAIL",
            });
          }

          let assignedRollNumber: string | undefined = undefined;

          if (role === "student") {
            const rawClass = (user as any).studentClass?.trim();
            const rawSection = (user as any).studentSection?.trim();
            const rawGroup = (user as any).group?.trim();

            if (rawClass && rawSection) {
              const cleanGrade = rawClass.replace(/(Class|Grade)\s*/i, "").trim();
              const classCriteria = [rawClass, `Class ${cleanGrade}`, `Grade ${cleanGrade}`, cleanGrade];

              const cleanSection = rawSection.replace(/Section\s*/i, "").trim();
              const sectionCriteria = [rawSection, `Section ${cleanSection}`, cleanSection];

              const groupFilter = rawGroup ? { group: rawGroup } : {};
              const classWhere = {
                role: { in: ["student", "STUDENT"] },
                studentClass: { in: classCriteria },
                ...groupFilter,
              };
              const sectionWhere = {
                ...classWhere,
                studentSection: { in: sectionCriteria },
              };

              // Section capacity check (Max 30 students per section)
              const sectionCount = await prisma.user.count({ where: sectionWhere });
              if (sectionCount >= 30) {
                throw new APIError("BAD_REQUEST", {
                  message: `${rawSection} of ${rawClass}${rawGroup ? ` (${rawGroup})` : ""} has reached maximum capacity (30 students). Please select another section.`,
                  code: "SECTION_FULL",
                });
              }

              // Class capacity check (Max 60 students per class / group)
              const classCount = await prisma.user.count({ where: classWhere });
              if (classCount >= 60) {
                throw new APIError("BAD_REQUEST", {
                  message: `${rawClass}${rawGroup ? ` (${rawGroup})` : ""} has reached maximum capacity (60 students).`,
                  code: "CLASS_FULL",
                });
              }

              // Auto-calculate next sequential roll number
              const existingStudents = await prisma.user.findMany({
                where: sectionWhere,
                select: { roll: true },
              });

              let maxRoll = 0;
              for (const s of existingStudents) {
                if (s.roll) {
                  const num = parseInt(s.roll.replace(/\D/g, ""), 10);
                  if (!isNaN(num) && num > maxRoll) {
                    maxRoll = num;
                  }
                }
              }

              assignedRollNumber = (maxRoll + 1).toString();
            }
          }

          const rawDob = (user as any).dateOfBirth;
          const rawSessionYear = (user as any).sessionYear || new Date().getFullYear().toString();
          const isDemo = isDemoEmail(email);

          let dobDate: Date | undefined = undefined;
          if (rawDob) {
            const parsed = new Date(rawDob);
            if (!isNaN(parsed.getTime())) {
              dobDate = parsed;
            }
          }

          return {
            data: {
              ...user,
              role,
              ...(role === "student" ? { sessionYear: rawSessionYear } : {}),
              ...(assignedRollNumber ? { roll: assignedRollNumber } : {}),
              // Any new registration starts in pending approval state (except demo users)
              isApproved: isDemo ? true : false,
              ...(dobDate ? { dateOfBirth: dobDate } : {}),
            },
          };
        },
      },
    },
  },

  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },

  hooks: {
    // Check if account is locked before initiating sign-in.
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-in/email") return;

      const email = (ctx.body?.email as string | undefined)?.toLowerCase().trim();
      if (!email) return;

      if (isDemoEmail(email)) {
        await handleDemoUserSignIn(email);
        return; // Demo accounts bypass pending approval & lockout checks
      }

      const user = await prisma.user.findUnique({
        where: { email },
        select: { lockedUntil: true, isApproved: true },
      });

      if (user && !user.isApproved) {
        throw new APIError("FORBIDDEN", {
          message:
            "Your account is pending admin approval. Please try again after an admin approves your account.",
          code: "ACCOUNT_PENDING_APPROVAL",
        });
      }

      if (user?.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
        throw new APIError("FORBIDDEN", {
          message: `Your account has been temporarily locked due to multiple incorrect password attempts. Please try again in ${formatRemainingLockTime(
            user.lockedUntil,
          )}.`,
          code: "ACCOUNT_LOCKED",
          // Used by frontend to display countdown (ISO timestamp).
          lockedUntil: user.lockedUntil.toISOString(),
        });
      }
    }),

    // After sign-in process completes, decide whether to increment
    // attempt count or reset based on result.
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-in/email") return;

      const email = (ctx.body?.email as string | undefined)?.toLowerCase().trim();
      if (!email) return;

      const returned = ctx.context.returned;
      const signInFailed = returned instanceof APIError;

      const user = await prisma.user.findUnique({
        where: { email },
        select: { failedLoginAttempts: true, lockedUntil: true },
      });
      if (!user) return;

      if (signInFailed) {
        const attempts = user.failedLoginAttempts + 1;

        if (attempts >= MAX_FAILED_LOGIN_ATTEMPTS) {
          const lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS);
          await prisma.user.update({
            where: { email },
            data: { failedLoginAttempts: 0, lockedUntil },
          });

          // Account just got locked — send "account locked" message + lockedUntil
          // instead of "wrong password" so frontend can start countdown immediately.
          throw new APIError("FORBIDDEN", {
            message: `You have entered an incorrect password ${MAX_FAILED_LOGIN_ATTEMPTS} times. For security reasons, your account has been locked for ${formatRemainingLockTime(
              lockedUntil,
            )}.`,
            code: "ACCOUNT_LOCKED",
            lockedUntil: lockedUntil.toISOString(),
          });
        }

        await prisma.user.update({
          where: { email },
          data: { failedLoginAttempts: attempts },
        });
      } else if (user.failedLoginAttempts > 0 || user.lockedUntil) {
        // Successful login — clear any previous failed attempts or lockout.
        await prisma.user.update({
          where: { email },
          data: { failedLoginAttempts: 0, lockedUntil: null },
        });
      }
    }),
  },
});

export type Auth = typeof auth;
