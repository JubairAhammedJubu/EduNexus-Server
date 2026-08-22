import "dotenv/config";
import express from "express";
import cors from "cors";
import authRoutes from "./routes/auth.routes.js";
import userRoutes from "./routes/user.routes.js";
import { prisma } from "./lib/prisma.js";

const app = express();

const clientOrigins = (process.env.CLIENT_ORIGIN ?? "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim());

app.use(
  cors({
    origin: clientOrigins,
    credentials: true, // required so the browser sends/receives the session cookie
  })
);

// Better Auth reads the raw request body itself, so its routes must be
// mounted BEFORE express.json() global middleware runs on them.
app.use("/api/auth", authRoutes);

app.use(express.json());

app.use("/api", userRoutes);

app.get("/health", async (_req, res) => {
  try {
    await prisma.$connect();
    res.json({ status: "ok", database: "connected" });
  } catch (error: any) {
    res.status(500).json({ status: "error", message: error?.message ?? "Database connection failed" });
  }
});

app.get("/", (_req, res) => {
  res.json({
    message: "EduNexus Server API is running 🚀",
    health: "/health",
  });
});

if (process.env.NODE_ENV !== "production" || !process.env.VERCEL) {
  const PORT = Number(process.env.PORT) || 5000;
  app.listen(PORT, async () => {
    console.log(`\n EduNexus Server running on http://localhost:${PORT}`);
    try {
      await prisma.$connect();
      console.log("🟢 DATABASE CONNECTED SUCCESSFULLY! (MongoDB)");
      console.log("⚡ API Ready at http://localhost:" + PORT);
    } catch (error) {
      console.error("❌ Database connection failed:", error);
    }
  });
}

export default app;


