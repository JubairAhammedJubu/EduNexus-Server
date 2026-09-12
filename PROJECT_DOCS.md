# EduNexus Server — Project Documentation

> **Express REST API** powering the EduNexus educational platform.  
> Stack: **TypeScript · Express · Prisma · MongoDB · Better Auth · Cloudflare R2 · Nodemailer**

---

## Table of Contents

1. [Tech Stack](#tech-stack)
2. [Folder Structure](#folder-structure)
3. [Environment Variables](#environment-variables)
4. [Scripts](#scripts)
5. [Database Models](#database-models)
6. [Authentication & Security](#authentication--security)
7. [Middleware](#middleware)
8. [API Endpoints](#api-endpoints)
9. [File Upload](#file-upload)
10. [Deployment](#deployment)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js (ESM) |
| Language | TypeScript 5.x |
| Web Framework | Express 4.x |
| Auth | Better Auth 1.x (email+password, TOTP 2FA, Bearer token) |
| ORM | Prisma 6.x |
| Database | MongoDB (Atlas) |
| File Storage | Cloudflare R2 (via AWS SDK S3 client) |
| Email | Nodemailer |
| Dev Server | `tsx watch` |
| Deployment | Vercel (serverless) |

---

## Folder Structure

```
EduNexus-Server/
├── api/
│   └── index.ts            # Vercel serverless entry point
├── prisma/
│   └── schema.prisma       # All Prisma / MongoDB models
├── src/
│   ├── index.ts            # Express app setup, CORS, route mounting, health check
│   ├── lib/
│   │   ├── auth.ts         # Better Auth configuration (plugins, hooks, lockout)
│   │   ├── mailer.ts       # Nodemailer transporter & email helpers
│   │   ├── prisma.ts       # Prisma client singleton
│   │   └── r2.ts           # Cloudflare R2 upload helpers (images & PDFs)
│   ├── middleware/
│   │   └── session.ts      # requireAuth & requireRole middleware
│   └── routes/
│       ├── auth.routes.ts          # Delegates all /api/auth/* to Better Auth
│       ├── user.routes.ts          # Profile, students list, 2FA admin actions
│       ├── notice.routes.ts        # CRUD for school notices
│       ├── assignment.routes.ts    # CRUD for assignments + student submission
│       ├── exam.routes.ts          # CRUD for examination schedules
│       ├── approval.routes.ts      # Admin user approval flow
│       ├── request.routes.ts       # Teacher class/subject requests
│       └── password-reset.routes.ts # Custom password reset flow
├── .env                    # Local environment variables (not committed)
├── .env.example            # Template for required env vars
├── package.json
├── tsconfig.json
└── vercel.json             # Vercel deployment config
```

---

## Environment Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | MongoDB connection URI |
| `BETTER_AUTH_URL` | Full public URL of the API server |
| `BETTER_AUTH_SECRET` | Secret key used by Better Auth to sign tokens/cookies |
| `CLIENT_ORIGIN` | Comma-separated list of allowed frontend origins |
| `NODE_ENV` | `production` or `development` |
| `R2_ACCOUNT_ID` | Cloudflare R2 account ID |
| `R2_ACCESS_KEY_ID` | R2 access key |
| `R2_SECRET_ACCESS_KEY` | R2 secret key |
| `R2_BUCKET_NAME` | R2 bucket name |
| `R2_PUBLIC_URL` | Public base URL for R2-hosted files |
| `SMTP_HOST` | SMTP server host |
| `SMTP_PORT` | SMTP server port |
| `SMTP_USER` | SMTP username / email |
| `SMTP_PASS` | SMTP password |

---

## Scripts

```bash
npm run dev             # Start dev server with hot-reload (tsx watch)
npm run build           # Generate Prisma client + compile TypeScript
npm run start           # Run compiled production server
npm run prisma:generate # Generate Prisma client
npm run prisma:push     # Push schema to MongoDB (no migrations)
```

---

## Database Models

### `User`
Core user document — shared by Better Auth and EduNexus role logic.

| Field | Type | Notes |
|---|---|---|
| `id` | ObjectId | Auto-generated |
| `name` | String | Required |
| `email` | String | Unique |
| `role` | String | `"admin"` \| `"teacher"` \| `"student"` |
| `phone`, `location`, `bio`, `department` | String? | Extended profile |
| `fatherName`, `motherName`, `dateOfBirth`, `address`, `bloodGroup` | Various? | Personal info |
| `schoolName`, `studentClass`, `studentSection` | String? | Student-only fields |
| `qualification` | String? | Teacher-only field |
| `failedLoginAttempts` | Int | For login lockout (resets on success) |
| `lockedUntil` | DateTime? | Account lock expiry |
| `twoFactorEnabled` | Boolean | TOTP 2FA flag |
| `isApproved` | Boolean | Admin approval gate (new accounts default `false`) |

### `Session`
Better Auth managed sessions.

| Field | Type | Notes |
|---|---|---|
| `token` | String | Unique session token |
| `expiresAt` | DateTime | 7-day TTL |
| `userId` | ObjectId | FK → User |
| `ipAddress`, `userAgent` | String? | |

### `Account`
OAuth / password account links managed by Better Auth.

| Field | Type |
|---|---|
| `accountId`, `providerId` | String |
| `accessToken`, `refreshToken`, `idToken` | String? |
| `password` | String? (hashed) |
| `userId` | ObjectId (FK → User) |

### `TwoFactor`
TOTP 2FA secrets managed by Better Auth's `twoFactor` plugin.

| Field | Type |
|---|---|
| `secret` | String (TOTP secret) |
| `backupCodes` | String (JSON encoded) |
| `failedVerificationCount` | Int |
| `lockedUntil` | DateTime? |
| `userId` | ObjectId (FK → User) |

### `Notice`
School-wide announcements posted by teachers or admins.

| Field | Type | Notes |
|---|---|---|
| `title` | String | Required |
| `detail` | String | Required |
| `category` | String | Default `"General"` |
| `isPinned` | Boolean | Pinned notices appear first |
| `teacherName` | String? | Display name of the author |
| `authorEmail` | String? | FK → User (by email) |

### `Assignment`
Homework/assignments created by teachers.

| Field | Type | Notes |
|---|---|---|
| `title` | String | Required |
| `subject`, `grade`, `section` | String | Required — targets a class |
| `dueDate` | DateTime | Required |
| `totalMarks` | Int | Default 100 |
| `status` | String | `"ACTIVE"` \| `"DRAFT"` \| `"CLOSED"` |
| `teacherEmail`, `teacherName` | String | Creator info |

### `Submission`
Student submission for an assignment. Max **2 attempts** per student.

| Field | Type | Notes |
|---|---|---|
| `assignmentId` | ObjectId | FK → Assignment |
| `studentId` | ObjectId | FK → User |
| `content` | String? | Text submission |
| `fileUrl` | String? | URL to uploaded PDF in R2 |
| `attemptsUsed` | Int | 1 or 2 |
| `status` | String | `"SUBMITTED"` \| `"GRADED"` \| `"LATE"` |
| `marks` | Int? | Set by teacher |
| `feedback` | String? | Teacher feedback |

> **Unique constraint**: `(assignmentId, studentId)` — one record per student per assignment.

### `Exam`
Examination schedule entries.

| Field | Type | Notes |
|---|---|---|
| `title`, `subject` | String | Required |
| `studentClass`, `section` | String | Target audience |
| `examType` | String | `"Class Test"` \| `"Quiz"` \| `"Mid-Term"` \| `"Final Term"` |
| `date` | String | `YYYY-MM-DD` |
| `startTime`, `endTime` | String | Defaults `09:00 AM` / `11:30 AM` |
| `totalMarks`, `passingMarks` | Int | Defaults 100 / 40 |
| `status` | String | `"Upcoming"` \| `"Ongoing"` \| `"Completed"` \| `"Cancelled"` |

### `ClassSubjectRequest`
Teacher requests to be assigned to a class/subject — reviewed by admin.

| Field | Type | Notes |
|---|---|---|
| `teacherEmail`, `teacherName` | String | Creator |
| `grade`, `section`, `subject`, `subjectCode` | String | Required |
| `status` | String | `"PENDING"` \| `"APPROVED"` \| `"REJECTED"` |
| `adminFeedback` | String? | Admin response |

---

## Authentication & Security

### Registration Rules
- Only institutional email addresses are accepted:
  - `@edunexus.std.com` → role assigned as `"student"`
  - `@edunexus.tchr.com` → role assigned as `"teacher"`
- All new registrations start with `isApproved: false` — an admin must approve before login.
- `autoSignIn: false` — users are redirected to the login page after registration.

### Login Lockout
- **3 failed login attempts** → account locked for **5 hours**
- A `lockedUntil` ISO timestamp is returned so the frontend can show a countdown
- A successful login resets `failedLoginAttempts` and clears `lockedUntil`

### Two-Factor Authentication (TOTP)
- Powered by Better Auth's `twoFactor` plugin (authenticator app / QR code)
- Once enabled, every login triggers a TOTP verification step
- Admins can reset 2FA for any user via `POST /api/admin/reset-2fa`

### Session
- Sessions expire after **7 days**; refreshed every **24 hours** of activity
- Supports both **Cookie** and **Bearer token** (`Authorization: Bearer <token>`)
- Secure cookies (`SameSite: none`, `Secure: true`) are enabled in production

---

## Middleware

### `requireAuth`
Validates the session (cookie or Bearer token) via Better Auth.  
Attaches `req.user` and `req.session` to the request.  
Returns `401 Unauthorized` if no valid session exists.

### `requireRole(...roles)`
Role-gate middleware — use **after** `requireAuth`.  
Returns `403 Forbidden` if the user's role is not in the allowed list.

```typescript
router.get("/admin/report", requireAuth, requireRole("admin"), handler);
router.post("/notices", requireAuth, requireRole("teacher", "admin"), handler);
```

---

## API Endpoints

### Auth Routes (`/api/auth/*`)

All authentication is handled by **Better Auth** and automatically available.

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/auth/sign-up/email` | Register a new account |
| `POST` | `/api/auth/sign-in/email` | Login with email + password |
| `POST` | `/api/auth/sign-out` | Logout / invalidate session |
| `GET` | `/api/auth/get-session` | Get current session info |
| `POST` | `/api/auth/two-factor/enable` | Enable TOTP 2FA (returns QR code) |
| `POST` | `/api/auth/two-factor/verify-totp` | Verify TOTP code during login |
| `POST` | `/api/auth/two-factor/disable` | Disable 2FA for self |

---

### User Routes (`/api`)

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/me` | Required | Get current user's profile |
| `GET` | `/api/admin/overview` | Admin | Admin dashboard greeting |
| `POST` | `/api/user/profile/image` | Required | Upload profile picture (max 5MB, multipart `file` field) |
| `PUT` | `/api/user/profile` | Required | Update profile fields |
| `GET` | `/api/teacher/students` | Teacher/Admin | Paginated student list (`?page&limit&search&studentClass`) |
| `GET` | `/api/admin/user-2fa-status` | Admin | Check user 2FA status (`?email=...`) |
| `POST` | `/api/admin/reset-2fa` | Admin | Reset user's 2FA (`{ "email": "..." }`) |

---

### Notice Routes (`/api/notices`)

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/notices` | Public | Get all notices (pinned first, then newest) |
| `POST` | `/api/notices` | Teacher/Admin | Create a new notice |
| `PUT` | `/api/notices/:id` | Teacher (own) / Admin (any) | Update a notice |
| `DELETE` | `/api/notices/:id` | Teacher (own) / Admin (any) | Delete a notice |

**POST body:**
```json
{
  "title": "required",
  "detail": "required",
  "category": "General",
  "isPinned": false,
  "teacherName": "optional",
  "authorEmail": "optional"
}
```

---

### Assignment Routes

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/student/assignments` | Student | Active assignments for student's class/section |
| `POST` | `/api/student/assignments/:id/upload` | Student | Upload PDF submission to R2 (max 2 attempts) |
| `POST` | `/api/student/assignments/:id/submit` | Student | Submit text/file (max 2 attempts) |
| `GET` | `/api/teacher/assignments` | Teacher/Admin | List assignments (`?status=ACTIVE`) |
| `POST` | `/api/teacher/assignments` | Teacher/Admin | Create a new assignment |
| `PATCH` | `/api/teacher/assignments/:id` | Teacher (own) / Admin | Update an assignment |
| `DELETE` | `/api/teacher/assignments/:id` | Teacher (own) / Admin | Delete an assignment |

**POST/PATCH body (teacher):**
```json
{
  "title": "required",
  "subject": "required",
  "grade": "required",
  "section": "required",
  "dueDate": "ISO date string (required)",
  "description": "optional",
  "totalMarks": 100,
  "status": "ACTIVE"
}
```

---

### Exam Routes (`/api/exams`)

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/exams` | Public | Get all exams (newest first) |
| `POST` | `/api/exams` | Public | Create a new exam |
| `PATCH` | `/api/exams/:id/cancel` | Public | Cancel an exam |

**POST body:**
```json
{
  "title": "required",
  "subject": "required",
  "studentClass": "required",
  "date": "YYYY-MM-DD (required)",
  "section": "Section A",
  "examType": "Mid-Term",
  "startTime": "09:00 AM",
  "endTime": "11:30 AM",
  "roomNo": "Hall 101",
  "totalMarks": 100,
  "passingMarks": 40,
  "invigilator": "string",
  "isYourDuty": true,
  "syllabus": "string",
  "teacherEmail": "string"
}
```

---

### Approval Routes

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/approval-status?email=...` | Public | Check if account is approved |
| `GET` | `/api/admin/pending-users` | Admin | List all pending users |
| `POST` | `/api/admin/approve-user` | Admin | Approve a user (`{ "userId": "..." }`) |

---

### Request Routes (`/api/requests`)

Teacher class/subject assignment requests reviewed by admin.

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/requests` | Teacher/Admin | List class-subject requests |
| `POST` | `/api/requests` | Teacher | Submit a new request |
| `PATCH` | `/api/requests/:id` | Admin | Approve / reject a request |
| `DELETE` | `/api/requests/:id` | Teacher/Admin | Delete a request |

---

### Password Reset Routes

Custom password reset flow (separate from Better Auth's built-in flow).

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/password-reset/request` | Public | Send reset email with OTP/link |
| `POST` | `/api/password-reset/verify` | Public | Verify the reset token |
| `POST` | `/api/password-reset/reset` | Public | Set a new password |

---

## File Upload

### Images (Profile Pictures)
- **Library:** Multer (memory storage)
- **Allowed MIME types:** `image/jpeg`, `image/png`, `image/webp`, `image/gif`
- **Max size:** 5 MB
- **Storage:** Cloudflare R2
- **Field name:** `file` or `image`

### PDFs (Assignment Submissions)
- **Library:** Multer (memory storage)
- **Allowed MIME types:** `application/pdf` (magic bytes `%PDF-` also verified)
- **Max size:** 10 MB
- **Storage:** Cloudflare R2
- **Field name:** `file`

---

## Deployment

The project is deployed on **Vercel** as a serverless function.

- **Entry point:** `api/index.ts` re-exports the Express `app` for Vercel's Node adapter
- **`vercel.json`** configures the build and routes
- **`trust proxy`** is enabled for correct behavior behind Vercel's CDN/proxy
- **Secure cookies** (`SameSite: none`, `Secure: true`) are automatically enabled in production

```bash
# Deploy to production
vercel --prod
```

---

## Health Check

```
GET /health
```
Returns database connection status.

```json
{ "status": "ok", "database": "connected" }
```

---

*Generated on 2026-09-09*
