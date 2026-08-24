import {betterAuth} from "better-auth";
import {bearer} from "better-auth/plugins";
import {prismaAdapter} from "better-auth/adapters/prisma";
import {APIError} from "better-auth/api";
import {prisma} from "./prisma.js";

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

  plugins: [bearer()],

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
    autoSignIn: true,
  },

  user: {
    additionalFields: {
      role: {
        type: ["admin", "teacher", "student"],
        required: false,
        defaultValue: "student",
        input: false, // client theke role pathano jabe na
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
});

export type Auth = typeof auth;
