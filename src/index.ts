import "dotenv/config";
import express from "express";
import cors from "cors";
import authRoutes from "./routes/auth.routes.js";
import userRoutes from "./routes/user.routes.js";
import { prisma } from "./lib/prisma.js";

const app = express();

// Required behind Cloud Reverse Proxies (Render, Railway, Fly.io, Vercel)
app.set("trust proxy", 1);

const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:5000",
  "https://school-management-system-psi-ten.vercel.app",
  ...(process.env.CLIENT_ORIGIN ? process.env.CLIENT_ORIGIN.split(",").map((origin) => origin.trim()) : []),
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, Postman, or server-to-server)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin) || origin.endsWith(".vercel.app")) {
        return callback(null, true);
      }
      return callback(null, true);
    },
    credentials: true, // required so the browser sends/receives the session cookie
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Cookie", "X-Requested-With", "Accept"],
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


