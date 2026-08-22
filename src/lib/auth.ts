import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "./prisma.js";

const clientOrigins = [
  "http://localhost:3000",
  "http://localhost:5000",
  "https://school-management-system-psi-ten.vercel.app",
  ...(process.env.CLIENT_ORIGIN ? process.env.CLIENT_ORIGIN.split(",").map((origin) => origin.trim()) : []),
].filter(Boolean);

const isProduction = process.env.NODE_ENV === "production" || (process.env.BETTER_AUTH_URL?.startsWith("https://") ?? false);

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:5000",
  secret: process.env.BETTER_AUTH_SECRET,
  basePath: "/api/auth",
  trustedOrigins: clientOrigins,

  plugins: [
    bearer(),
  ],

  database: prismaAdapter(prisma, {
    provider: "mongodb",
  }),

  // Better Auth's own id generator doesn't produce valid Mongo ObjectId
  // hex strings. Turning this off lets Prisma/MongoDB generate the
  // "_id" for every model (User, Session, Account, Verification) via
  // `@default(auto())` in schema.prisma instead.
  advanced: {
    database: { generateId: false },
    useSecureCookies: isProduction,
    defaultCookieAttributes: {
      sameSite: isProduction ? "none" : "lax",
      secure: isProduction,
      partitioned: isProduction,
    },
  },

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    autoSignIn: true,
  },

  user: {
    additionalFields: {
      role: {
        type: ["admin", "teacher", "student"],
        required: false,
        defaultValue: "student",
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
