import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "./prisma.js";

const clientOrigins = (process.env.CLIENT_ORIGIN ?? "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim());

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:5000",
  secret: process.env.BETTER_AUTH_SECRET,
  basePath: "/api/auth",

  database: prismaAdapter(prisma, {
    provider: "mongodb",
  }),

  // Better Auth's own id generator doesn't produce valid Mongo ObjectId
  // hex strings. Turning this off lets Prisma/MongoDB generate the
  // "_id" for every model (User, Session, Account, Verification) via
  // `@default(auto())` in schema.prisma instead.
  advanced: {
    database: {
      generateId: false,
    },
  },

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    autoSignIn: true,
  },

  // The Next.js app (a different port = different origin) is allowed to
  // call these auth routes with credentials (cookies) attached.
  trustedOrigins: clientOrigins,

  user: {
    additionalFields: {
      role: {
        type: ["admin", "teacher", "student"],
        required: false,
        defaultValue: "student",
        // Still accepted as sign-up input so student/teacher can pick
        // their role. Lock this down (input: false) once you add an
        // admin-invite flow — self-service "admin" sign-up is only fine
        // for local development/demo purposes.
        input: true,
      },
    },
  },

  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // refresh the cookie once a day of use
  },
});

export type Auth = typeof auth;
