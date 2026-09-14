# EduNexus Server — Comprehensive Project Documentation & Summary

> **Express REST API** powering the EduNexus educational management platform.  
> Stack: **TypeScript (ESM) · Express · Prisma · MongoDB Atlas · Better Auth · Cloudflare R2 · Nodemailer**

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Tech Stack](#tech-stack)
3. [Folder Structure](#folder-structure)
4. [Environment Variables](#environment-variables)
5. [Scripts](#scripts)
6. [Database Models (Prisma Schema Summary)](#database-models-prisma-schema-summary)
7. [Authentication & Security Architecture](#authentication--security-architecture)
8. [Middleware](#middleware)
9. [API Endpoints Reference](#api-endpoints-reference)
   - [Auth Routes](#auth-routes-apiauth)
   - [User & Profile Routes](#user--profile-routes-api)
   - [Admin Management Routes](#admin-management-routes-apiadmin)
   - [Attendance Routes](#attendance-routes-apiteacherattendance)
   - [Result & Grading Routes](#result--grading-routes-apiteacherresults)
   - [Assignment & Submission Routes](#assignment--submission-routes)
   - [Notice Routes](#notice-routes-apinotices)
   - [Exam Routes](#exam-routes-apiexams)
   - [Approval Gate Routes](#approval-gate-routes)
   - [Teacher Request Routes](#teacher-request-routes-apiteacherrequests)
   - [Password Reset Routes](#password-reset-routes-apipassword-reset)
10. [File Storage (Cloudflare R2)](#file-storage-cloudflare-r2)
11. [Deployment & Health Check](#deployment--health-check)

---

## Executive Summary

**EduNexus Server** is an institutional education platform backend designed to handle school administration, teacher workflows, and student activities in a secure, multi-tenant environment. 

### Core Capabilities

- **Role-Based Access Control (RBAC):** Strict isolation between `admin`, `teacher`, and `student` roles. Email domain enforcement maps `@edunexus.std.com` to students and `@edunexus.tchr.com` to teachers.
- **Robust Security & Two-Factor Authentication:** Powered by Better Auth with TOTP 2FA support, admin-controlled 2FA resets, and automated account lockout after 3 failed login attempts (5-hour cooldown).
- **Admin Approval Gate:** New registrations default to unapproved (`isApproved: false`), requiring admin verification before access is granted.
- **Academic Management:**
  - **Assignments:** Creation, status toggles, student submission tracking, PDF attachments via Cloudflare R2, and a strict 2-attempt limit.
  - **Attendance Tracking:** Daily and range-based attendance rosters (Present, Late, Absent) strictly scoped to sections and classes, with automated statistical trend calculations.
  - **Results & Examination:** Exam scheduling, invigilation duty assignment, and student result grading with draft/published workflows.
  - **Teacher Requests:** Formal request pipeline for teachers to request specific grades, sections, and subjects.
- **Administrative Utilities:** Aggregated system metric dashboards, user role adjustments, account unlocking, user revocation/deletion, and on-the-fly downloadable PDF receipt generation.
- **Cloud Infrastructure:** Multi-cloud architecture leveraging MongoDB Atlas for document storage, Cloudflare R2 for S3-compatible asset storage, Nodemailer for transactional alerts, and Vercel Serverless deployment readiness.

---

## Tech Stack

| Layer | Technology | Description |
|---|---|---|
| **Runtime** | Node.js (ESM) | Modern ECMAScript module syntax |
| **Language** | TypeScript 5.6.x | Strict type safety and compilation |
| **Web Framework** | Express 4.21.x | REST API server and route handling |
| **Auth Engine** | Better Auth 1.7.x | Email/password, session tokens, TOTP 2FA plugin |
| **ORM** | Prisma 6.18.x | Type-safe query engine and database modeling |
| **Database** | MongoDB (Atlas Replica Set) | Document database storage |
| **File Storage** | Cloudflare R2 | S3-compatible bucket via `@aws-sdk/client-s3` |
| **Email Service** | Nodemailer 10.x | Transactional email delivery |
| **Development** | `tsx watch` | Zero-config TypeScript hot-reload server |
| **Hosting / Deploy**| Vercel Serverless | Node serverless function adapter (`api/index.ts`) |

---

## Folder Structure

```
EduNexus-Server/
├── api/
│   └── index.ts                     # Vercel serverless adapter entry point
├── prisma/
│   └── schema.prisma                # Prisma MongoDB schema definition (12 models)
├── src/
│   ├── index.ts                     # Main Express server setup, CORS, route registry, health
│   ├── lib/
│   │   ├── auth.ts                  # Better Auth configuration, hooks, 2FA, lockout rules
│   │   ├── mailer.ts                # Nodemailer transporter and transactional emails
│   │   ├── prisma.ts                # PrismaClient singleton instance
│   │   └── r2.ts                    # Cloudflare R2 S3 client & upload utilities
│   ├── middleware/
│   │   └── session.ts               # requireAuth & requireRole middleware
│   └── routes/
│       ├── admin.routes.ts          # Admin stats, user CRUD, unlock, PDF receipts
│       ├── approval.routes.ts       # Registration approval checking & admin approvals
│       ├── assignment.routes.ts     # Student & teacher assignments, file uploads & grading
│       ├── attendance.routes.ts     # Student roster, attendance marking, daily/weekly stats
│       ├── auth.routes.ts           # Forwarding to Better Auth handler (/api/auth/*)
│       ├── exam.routes.ts           # Exam schedule creation, listing, cancellation
│       ├── notice.routes.ts         # School-wide announcements & pin management
│       ├── password-reset.routes.ts # Custom 2FA-verified password reset flow
│       ├── request.routes.ts        # Teacher class/subject request submissions & admin review
│       ├── result.routes.ts         # Student exam/assignment result recording & updates
│       └── user.routes.ts           # Profile read/update, image uploads, 2FA admin resets
├── .env.example                     # Environment variables template
├── package.json                     # Dependencies, scripts, and project metadata
├── tsconfig.json                    # TypeScript compiler configuration
└── vercel.json                      # Vercel routing and serverless function config
```

---

## Environment Variables

| Variable | Required | Description | Example |
|---|---|---|---|
| `PORT` | Optional | Server port (default: 5000) | `5000` |
| `DATABASE_URL` | **Yes** | MongoDB replica set connection URI | `mongodb+srv://user:pass@cluster.mongodb.net/edunexus` |
| `BETTER_AUTH_URL` | **Yes** | Public base URL of this API server | `http://localhost:5000` or `https://api.edunexus.com` |
| `BETTER_AUTH_SECRET` | **Yes** | Encryption key for signing sessions and tokens | Base64 32-byte secret |
| `CLIENT_ORIGIN` | **Yes** | Allowed frontend origins (comma-separated) | `http://localhost:3000,https://edunexus.vercel.app` |
| `NODE_ENV` | Optional | Environment mode | `development` \| `production` |
| `R2_ACCOUNT_ID` | **Yes** | Cloudflare account ID | `a1b2c3d4...` |
| `R2_ACCESS_KEY_ID` | **Yes** | Cloudflare R2 S3 access key | `...` |
| `R2_SECRET_ACCESS_KEY`| **Yes** | Cloudflare R2 S3 secret key | `...` |
| `R2_BUCKET_NAME` | **Yes** | Cloudflare R2 bucket name | `edunexus-storage` |
| `R2_PUBLIC_URL` | **Yes** | Public URL serving R2 bucket files | `https://assets.edunexus.com` |
| `SMTP_HOST` | Optional | SMTP host for email sending | `smtp.gmail.com` |
| `SMTP_PORT` | Optional | SMTP port | `587` |
| `SMTP_USER` | Optional | SMTP email username | `noreply@edunexus.com` |
| `SMTP_PASS` | Optional | SMTP email app password | `app-specific-password` |

---

## Scripts

```bash
npm run dev             # Start dev server with tsx hot-reloading
npm run build           # Run prisma generate followed by TypeScript compilation (tsc)
npm run start           # Start compiled production server (dist/index.js)
npm run prisma:generate # Re-generate Prisma Client from prisma/schema.prisma
npm run prisma:push     # Synchronize Prisma schema directly to MongoDB without migrations
```

---

## Database Models (Prisma Schema Summary)

EduNexus Server defines **12 distinct models** in `prisma/schema.prisma`:

### 1. `User` (`users` collection)
Core user model shared by Better Auth and application-specific RBAC logic.
- **Identity & Auth:** `id`, `name`, `email` (unique), `emailVerified`, `image`, `role` (`"admin"` | `"teacher"` | `"student"`).
- **Security & Lockout:** `failedLoginAttempts` (default 0), `lockedUntil` (DateTime?), `twoFactorEnabled` (default false), `isApproved` (default true, forced false on new signup).
- **Personal & Extended Profile:** `phone`, `location`, `department`, `bio`, `fatherName`, `motherName`, `dateOfBirth`, `address`, `bloodGroup`.
- **Academic Profile:** `schoolName`, `studentClass`, `studentSection` (students); `qualification` (teachers).
- **Relations:** `sessions`, `accounts`, `notices`, `twoFactors`, `submissions`, `attendances`.

### 2. `Session` (`sessions` collection)
Tracks active sessions (7-day duration, 24-hour refresh window).
- `id`, `token` (unique), `expiresAt`, `ipAddress`, `userAgent`, `userId` (FK → `User`).

### 3. `Account` (`accounts` collection)
Stores authentication credentials and password hashes.
- `id`, `accountId`, `providerId`, `accessToken`, `refreshToken`, `password` (hashed), `userId` (FK → `User`).

### 4. `Verification` (`verifications` collection)
Used by Better Auth for temporary token and verification validations.
- `id`, `identifier`, `value`, `expiresAt`.

### 5. `TwoFactor` (`two_factors` collection)
Maintains TOTP 2FA secret keys and emergency backup recovery codes.
- `id`, `secret` (encrypted TOTP secret), `backupCodes`, `verified`, `failedVerificationCount`, `lockedUntil`, `userId` (FK → `User`).

### 6. `Notice` (`notices` collection)
School-wide announcements and noticeboard items.
- `id`, `title`, `detail`, `category` (default: `"General"`), `isPinned` (Boolean), `teacherName`, `authorEmail` (FK → `User.email`), `createdAt`, `updatedAt`.

### 7. `ClassSubjectRequest` (`class_subject_requests` collection)
Requests submitted by teachers to instruct specific classes/subjects.
- `id`, `teacherEmail`, `teacherName`, `grade`, `section`, `subject`, `subjectCode`, `group`, `room`, `schedule`, `time`, `reason`, `status` (`"PENDING"` | `"APPROVED"` | `"REJECTED"`), `adminFeedback`.

### 8. `Assignment` (`assignments` collection)
Assignments created by teachers for specific classes and sections.
- `id`, `title`, `description`, `subject`, `grade`, `section`, `dueDate`, `totalMarks` (default 100), `status` (`"ACTIVE"` | `"DRAFT"` | `"CLOSED"`), `submitStatus`, `teacherEmail`, `teacherName`, `submissions` (Relation).
- **Indexes:** `teacherEmail`, `status`, `dueDate`.

### 9. `Submission` (`submissions` collection)
Student submissions for specific assignments.
- `id`, `assignmentId` (FK → `Assignment`), `studentId` (FK → `User`), `studentEmail`, `content`, `fileUrl` (Cloudflare R2 link), `attemptsUsed` (max 2), `marks`, `status` (`"SUBMITTED"` | `"GRADED"` | `"LATE"`), `feedback`, `submittedAt`.
- **Constraint:** `@@unique([assignmentId, studentId])` — exactly one record per student per assignment with attempt counter.

### 10. `Exam` (`examinations` collection)
Official examination dates, rooms, and invigilation assignments.
- `id`, `title`, `subject`, `studentClass`, `section`, `group`, `examType` (`"Class Test"` | `"Quiz"` | `"Mid-Term"` | `"Final Term"`), `date` (`YYYY-MM-DD`), `startTime`, `endTime`, `roomNo`, `totalMarks`, `passingMarks`, `invigilator`, `isYourDuty`, `syllabus`, `status` (`"Upcoming"` | `"Ongoing"` | `"Completed"` | `"Cancelled"`), `teacherEmail`.
- **Indexes:** `studentClass`, `status`, `date`.

### 11. `StudentResult` (`results` collection)
Grading results for students on assignments or exams.
- `id`, `studentId`, `studentName`, `studentEmail`, `studentClass`, `assignmentId` (optional), `exam`, `score`, `total`, `grade`, `status` (`"DRAFT"` | `"PUBLISHED"`).
- **Indexes:** `studentId`, `studentEmail`, `assignmentId`, `status`.

### 12. `Attendance` (`attendances` collection)
Daily student attendance records logged by teachers.
- `id`, `studentId` (FK → `User`), `studentEmail`, `studentName`, `teacherEmail`, `grade` (Class 6 - Class 10), `section` (`"Section A"` | `"Section B"`), `group` (Science / Business / Humanities), `status` (`"PRESENT"` | `"LATE"` | `"ABSENT"`), `date` (DateTime).
- **Constraints & Indexes:** `@@unique([studentId, date])`, indexed by `teacherEmail`, `[grade, section]`, `date`.

---

## Authentication & Security Architecture

### 1. Institutional Registration Validation
During sign-up (`before` hook in `src/lib/auth.ts`):
- Emails ending with `@edunexus.std.com` are assigned `role: "student"`.
- Emails ending with `@edunexus.tchr.com` are assigned `role: "teacher"`.
- Any other email domain is rejected immediately with a 400 Bad Request.
- Newly registered accounts are forced to `isApproved: false`.
- `autoSignIn: false` ensures students/teachers cannot proceed into the app until approved by an administrator.

### 2. Login Lockout Protection
- Tracks `failedLoginAttempts`.
- Upon **3 failed attempts**, `lockedUntil` is set to **now + 5 hours**.
- Subsequent sign-in attempts during this period return a 403 response specifying the remaining lockout duration in minutes/hours.
- A successful login clears `failedLoginAttempts` and resets `lockedUntil`.
- Admins can manually release locks via `PATCH /api/admin/users/:id/unlock`.

### 3. Two-Factor Authentication (TOTP)
- Standard TOTP protocol with 6-digit codes and QR code registration.
- If enabled, login requires code verification (`/api/auth/two-factor/verify-totp`).
- Admins have an override endpoint (`POST /api/admin/reset-2fa`) to reset lost authenticator setups.

### 4. Dual-Mode Session Validation
Sessions are validated by `requireAuth`:
- **Web Cookies:** Secure `httpOnly` cookies with `SameSite=none` in production.
- **Mobile / External Bearer Tokens:** `Authorization: Bearer <token>` header support via Better Auth's `bearer` plugin.

---

## Middleware

### `requireAuth`
- Validates the active session against Better Auth using request headers/cookies.
- Attaches authenticated `req.user` and `req.session` to Express's request object.
- Returns `401 Unauthorized` if no session is present or expired.

### `requireRole(...roles)`
- Must be used immediately after `requireAuth`.
- Checks if `req.user.role` matches one of the authorized roles.
- Returns `403 Forbidden` if unauthorized.

---

## API Endpoints Reference

### Auth Routes (`/api/auth/*`)
Directly serviced by Better Auth:

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/auth/sign-up/email` | Register a new user (`name`, `email`, `password`) |
| `POST` | `/api/auth/sign-in/email` | Authenticate with email and password |
| `POST` | `/api/auth/sign-out` | Destroy active session and invalidate cookie/token |
| `GET` | `/api/auth/get-session` | Return current authenticated user and session data |
| `POST` | `/api/auth/two-factor/enable` | Enable TOTP 2FA and receive QR code payload |
| `POST` | `/api/auth/two-factor/verify-totp` | Complete 2FA login verification |
| `POST` | `/api/auth/two-factor/disable` | Disable 2FA on own account |

---

### User & Profile Routes (`/api`)

| Method | Path | Access | Description |
|---|---|---|---|
| `GET` | `/api/me` | Authenticated | Fetch current user profile with extended fields |
| `GET` | `/api/admin/overview` | Admin | Quick overview check for admin role |
| `POST` | `/api/user/profile/image` | Authenticated | Upload profile avatar (max 5MB image to R2) |
| `PUT` | `/api/user/profile` | Authenticated | Update user profile, contact, personal & academic details |
| `GET` | `/api/teacher/students` | Teacher / Admin | Paginated list of students (`?page&limit&search&studentClass`) |
| `GET` | `/api/admin/user-2fa-status` | Admin | Query 2FA status for a user by `?email=...` |
| `POST` | `/api/admin/reset-2fa` | Admin | Reset TOTP 2FA for a user (`{ email }`) |

---

### Admin Management Routes (`/api/admin`)

| Method | Path | Access | Description |
|---|---|---|---|
| `GET` | `/api/admin/stats` | Admin | Summary counts (users, teachers, students, locked, pending, assignments, results, exams) |
| `GET` | `/api/admin/users` | Admin | Filtered & paginated user registry (`?page&limit&search&role&isApproved&isLocked`) |
| `GET` | `/api/admin/teachers` | Admin | Retrieve all approved teachers for assignment/dropdowns |
| `PATCH` | `/api/admin/users/:id/role` | Admin | Change user role (`student`, `teacher`, `admin`) |
| `PATCH` | `/api/admin/users/:id` | Admin | Modify user properties (name, phone, class, department, approval) |
| `PATCH` | `/api/admin/users/:id/disapprove` | Admin | Revoke access by setting `isApproved = false` |
| `PATCH` | `/api/admin/users/:id/unlock` | Admin | Clear failed login attempts and reset lockout timer |
| `DELETE` | `/api/admin/users/:id` | Admin | Cascade-delete user and related records |
| `POST` | `/api/admin/receipts/generate-pdf` | Admin | Generate downloadable PDF fee receipt |

---

### Attendance Routes (`/api/teacher/attendance`)

| Method | Path | Access | Description |
|---|---|---|---|
| `GET` | `/api/teacher/attendance/students` | Teacher | Get student roster with attendance status (`?grade&section&group&date&startDate&endDate`) |
| `POST` | `/api/teacher/attendance/mark` | Teacher | Upsert attendance records for class/section students (`records: [{ studentId, status }]`) |
| `GET` | `/api/teacher/attendance/stats` | Teacher | Attendance stats (total, present, late, absent, weekly trends, class breakdown) |

---

### Result & Grading Routes (`/api/teacher/results`)

| Method | Path | Access | Description |
|---|---|---|---|
| `POST` | `/api/teacher/results` | Public / Teacher | Record a new student result (`studentId`, `exam`, `score`, `total`, `grade`, `status`) |
| `GET` | `/api/teacher/results` | Public / Teacher | Filter results (`?studentId&studentEmail&assignmentId&status`) |
| `PATCH` | `/api/teacher/results/:id` | Public / Teacher | Update an existing student result entry |
| `DELETE` | `/api/teacher/results/:id` | Public / Teacher | Delete a student result entry |

---

### Assignment & Submission Routes

| Method | Path | Access | Description |
|---|---|---|---|
| `GET` | `/api/student/assignments` | Student | List active assignments matching student's grade & section |
| `POST` | `/api/student/assignments/:id/upload` | Student | Upload assignment submission PDF to R2 (max 2 attempts) |
| `POST` | `/api/student/assignments/:id/submit` | Student | Submit assignment content or file URL |
| `GET` | `/api/teacher/assignments` | Teacher / Admin | List assignments created by teacher (`?status=ACTIVE`) |
| `GET` | `/api/teacher/assignments/:id/submissions`| Teacher / Admin | List all student submissions for an assignment |
| `POST` | `/api/teacher/assignments` | Teacher / Admin | Create a new assignment |
| `PATCH` | `/api/teacher/assignments/:id` | Teacher / Admin | Update assignment metadata or status |
| `DELETE` | `/api/teacher/assignments/:id` | Teacher / Admin | Delete an assignment |

---

### Notice Routes (`/api/notices`)

| Method | Path | Access | Description |
|---|---|---|---|
| `GET` | `/api/notices` | Public | List all notices (pinned notices listed first, then newest) |
| `POST` | `/api/notices` | Teacher / Admin | Publish a new notice |
| `PUT` | `/api/notices/:id` | Teacher (own) / Admin | Edit a notice |
| `DELETE` | `/api/notices/:id` | Teacher (own) / Admin | Remove a notice |

---

### Exam Routes (`/api/exams`)

| Method | Path | Access | Description |
|---|---|---|---|
| `GET` | `/api/exams` | Public | List all scheduled exams |
| `POST` | `/api/exams` | Public / Teacher | Create a new exam schedule entry |
| `PATCH` | `/api/exams/:id/cancel` | Public / Admin | Mark an exam as `"Cancelled"` |

---

### Approval Gate Routes

| Method | Path | Access | Description |
|---|---|---|---|
| `GET` | `/api/approval-status` | Public | Polled by frontend during login: checks if `?email=...` is approved |
| `GET` | `/api/admin/pending-users` | Admin | Returns all registered users awaiting approval |
| `POST` | `/api/admin/approve-user` | Admin | Set `isApproved: true` for a given `userId` |

---

### Teacher Request Routes (`/api/teacher/requests`)

| Method | Path | Access | Description |
|---|---|---|---|
| `GET` | `/api/teacher/requests` | Teacher / Admin | List class/subject assignment requests |
| `POST` | `/api/teacher/requests` | Teacher / Admin | Submit a request for grade, section, subject |
| `DELETE` | `/api/teacher/requests/:id` | Teacher / Admin | Cancel a pending request |
| `PATCH` | `/api/admin/requests/:id` | Admin | Approve or reject a request with feedback |

---

### Password Reset Routes (`/api/password-reset`)

| Method | Path | Access | Description |
|---|---|---|---|
| `POST` | `/api/password-reset/verify-code` | Public | Verify email + TOTP authenticator code, returns a 5-min `resetToken` |
| `POST` | `/api/password-reset/set-password` | Public | Spend `resetToken` to securely update account password |

---

## File Storage (Cloudflare R2)

Cloudflare R2 handles binary assets with memory-buffered Multer uploads (`src/lib/r2.ts`):

- **Profile Images:**
  - MIME types allowed: `image/jpeg`, `image/png`, `image/webp`, `image/gif`
  - Max File Size: `5 MB`
  - Destination key pattern: `profiles/{userId}-{timestamp}.{ext}`
- **Assignment Submissions:**
  - MIME types allowed: `application/pdf` (verified with `%PDF-` magic byte validation)
  - Max File Size: `10 MB`
  - Destination key pattern: `assignments/{assignmentId}/{studentId}-{timestamp}.pdf`

---

## Deployment & Health Check

### Health Check Endpoint
```http
GET /health
```
**Success Response:**
```json
{
  "status": "ok",
  "database": "connected"
}
```

### Deployment Configuration
- **Serverless Adapter:** `api/index.ts` exposes Express directly to Vercel's Node runtime.
- **Trust Proxy:** `app.set("trust proxy", 1)` enabled for secure headers behind Vercel/Cloudflare proxies.
- **CORS Config:** Configured with dynamic origin lookup and credentials support.

---

*Last Updated: September 2026*
