import "dotenv/config";
import express from "express";
import cors from "cors";
import authRoutes from "./routes/auth.routes.js";
import userRoutes from "./routes/user.routes.js";

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

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

const PORT = Number(process.env.PORT) || 5000;

app.listen(PORT, () => {
  console.log(`EduNexus API listening on http://localhost:${PORT}`);
});
