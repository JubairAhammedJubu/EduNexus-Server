const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

console.log(
  "studentResult delegate:",
  typeof prisma.studentResult
);

prisma.$disconnect();