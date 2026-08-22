# EduNexus API (Express + Better Auth + Prisma + MongoDB)

Authentication backend for the EduNexus school management system.

```
Next.js Frontend
      │
      ▼
Express.js REST API  ◄──── Better Auth (auth routes + session-verify middleware)
      │
      ▼
Prisma ORM
      │
      ▼
MongoDB
```

## Setup

1. **Install dependencies**
   ```bash
   cd server
   npm install
   ```

2. **Configure environment variables**
   ```bash
   cp .env.example .env
   ```
   - `DATABASE_URL` — a MongoDB connection string. Prisma's Mongo connector needs a **replica set**
     (a free [MongoDB Atlas](https://cloud.mongodb.com) cluster already is one; a local `mongod` needs
     `--replSet` enabled).
   - `BETTER_AUTH_SECRET` — generate with `openssl rand -base64 32`.
   - `CLIENT_ORIGIN` — the URL of the Next.js app (defaults to `http://localhost:3000`).

3. **Push the schema to MongoDB** (Mongo has no migrations, so use `db push` instead of `migrate`)
   ```bash
   npm run prisma:generate
   npm run prisma:push
   ```

4. **Run the dev server**
   ```bash
   npm run dev
   ```
   The API starts on `http://localhost:5000`. Health check: `GET /health`.

## What's included

- `src/lib/auth.ts` — Better Auth instance: email/password auth, Prisma+MongoDB adapter, a
  custom `role` field (`admin` | `teacher` | `student`) on the user, and `trustedOrigins` for the
  Next.js app's cookie-based session.
- `src/routes/auth.routes.ts` — mounts every Better Auth route (`sign-up`, `sign-in`, `sign-out`,
  `get-session`, ...) at `/api/auth/*`.
- `src/middleware/session.ts` — `requireAuth` (401s if there's no valid session) and
  `requireRole("admin", ...)` (403s if the user's role isn't allowed) for protecting routes.
- `src/routes/user.routes.ts` — example protected endpoints (`GET /api/me`, an admin-only route)
  showing how to use the middleware.

## Auth endpoints (all under `/api/auth`)

| Endpoint | Method | Body |
|---|---|---|
| `/api/auth/sign-up/email` | POST | `{ email, password, name, role? }` |
| `/api/auth/sign-in/email` | POST | `{ email, password }` |
| `/api/auth/sign-out` | POST | — |
| `/api/auth/get-session` | GET | — |

Sessions are stored as an httpOnly cookie set on the response — the frontend never needs to
manage tokens manually, it just needs `credentials: "include"` on its requests (the
`better-auth/react` client does this automatically).
