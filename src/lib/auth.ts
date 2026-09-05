import {betterAuth} from "better-auth";
import {bearer, twoFactor} from "better-auth/plugins";
import {prismaAdapter} from "better-auth/adapters/prisma";
import {APIError, createAuthMiddleware} from "better-auth/api";
import {prisma} from "./prisma.js";

// ── Login lockout policy ───────────────────────────────────────────
// Kew 3 bar bhul password dile, tar account 5 ghontar jonno login
// kora theke lock hoye jabe.
const MAX_FAILED_LOGIN_ATTEMPTS = 3;
const LOCKOUT_DURATION_MS = 5 * 60 * 60 * 1000; // 5 hours

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
    bearer(),
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
    database: {generateId: false},
    useSecureCookies: isProduction,
    defaultCookieAttributes: {
      sameSite: isProduction ? "none" : "lax",
      secure: isProduction,
    },
  },

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    // Registration-er por account pending-approval obosthay thake, tai
    // shathe shathe sign in kore dei na — user-ke login form-e pathiye
    // dei, approve howar por normal login diye dhukte hobe.
    autoSignIn: false,
  },

  user: {
    additionalFields: {
      role: {
        type: ["admin", "teacher", "student"],
        required: false,
        defaultValue: "student",
        input: false, // client theke role pathano jabe na
      },
      phone:{
        type: "string",
        required: false,
      },
        location: {
        type: "string",
        required: false,
      },
      bio:{
        type: "string",
        required: false,
      },
      department:{
        type: "string",
        required: false,
      },
      studentClass:{
        type: "string",
        required: false,
      },
      studentSection:{
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
        input: false, // client theke set kora jabe na — shudhu admin approve endpoint diye change hoy
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
            // Institution email na hole registration reject
            throw new APIError("BAD_REQUEST", {
              message:
                "Not an institution email. Use your @edunexus.std.com or @edunexus.tchr.com address to register.",
              code: "NOT_INSTITUTION_EMAIL",
            });
          }

          return {
            data: {
              ...user,
              role,
              // Notun kono registration always pending approval-e shuru
              // hoy — admin approve na kora porjonto login kora jabe na
              // (dekho hooks.before, "/sign-in/email" check-e).
              isApproved: false,
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
    // Sign-in shuru howar age check kori account lock kina.
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-in/email") return;

      const email = (ctx.body?.email as string | undefined)?.toLowerCase().trim();
      if (!email) return;

      const user = await prisma.user.findUnique({
        where: {email},
        select: {lockedUntil: true, isApproved: true},
      });

      if (user && !user.isApproved) {
        throw new APIError("FORBIDDEN", {
          message:
            "Apnar account ekhono admin approval-er jonno pending ache. Doya kore admin approve korar por abar try korun.",
          code: "ACCOUNT_PENDING_APPROVAL",
        });
      }

      if (user?.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
        throw new APIError("FORBIDDEN", {
          message: `Onek bar bhul password deyar karone apnar account temporarily lock kora hoyeche. Doya kore ${formatRemainingLockTime(
            user.lockedUntil,
          )} por abar try korun.`,
          code: "ACCOUNT_LOCKED",
          // Frontend eta diye countdown dekhabe (ISO timestamp).
          lockedUntil: user.lockedUntil.toISOString(),
        });
      }
    }),

    // Sign-in process shesh howar por result dekhe decide kori attempt
    // count barabo naki reset korbo.
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-in/email") return;

      const email = (ctx.body?.email as string | undefined)?.toLowerCase().trim();
      if (!email) return;

      const returned = ctx.context.returned;
      const signInFailed = returned instanceof APIError;

      const user = await prisma.user.findUnique({
        where: {email},
        select: {failedLoginAttempts: true, lockedUntil: true},
      });
      if (!user) return;

      if (signInFailed) {
        const attempts = user.failedLoginAttempts + 1;

        if (attempts >= MAX_FAILED_LOGIN_ATTEMPTS) {
          const lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS);
          await prisma.user.update({
            where: {email},
            data: {failedLoginAttempts: 0, lockedUntil},
          });

          // Just-now-locked hoyeche — eibar-i "wrong password" er bodole
          // "account locked" message + lockedUntil pathai, jate frontend
          // shathe shathe countdown shuru korte pare.
          throw new APIError("FORBIDDEN", {
            message: `Apni ${MAX_FAILED_LOGIN_ATTEMPTS} bar bhul password diyechen. Nirapottar jonno apnar account ${formatRemainingLockTime(
              lockedUntil,
            )} er jonno lock kora holo.`,
            code: "ACCOUNT_LOCKED",
            lockedUntil: lockedUntil.toISOString(),
          });
        }

        await prisma.user.update({
          where: {email},
          data: {failedLoginAttempts: attempts},
        });
      } else if (user.failedLoginAttempts > 0 || user.lockedUntil) {
        // Successful login — purono kono bhul attempt / lock thakle clear kore dei.
        await prisma.user.update({
          where: {email},
          data: {failedLoginAttempts: 0, lockedUntil: null},
        });
      }
    }),
  },
});

export type Auth = typeof auth;
