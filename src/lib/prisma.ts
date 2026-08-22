import { PrismaClient } from "@prisma/client";

// Reuse a single PrismaClient instance across hot reloads / imports
// instead of opening a fresh MongoDB connection pool every time this
// module is imported.
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma = global.__prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  global.__prisma = prisma;
}
