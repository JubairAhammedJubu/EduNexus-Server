# EduNexus Server — Comprehensive Project Documentation & Summary

> **Express REST API** powering the EduNexus educational management platform.  
> Stack: **TypeScript (ESM) · Express · Prisma · MongoDB Atlas · Better Auth · Cloudflare R2 · Nodemailer**

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [System Architecture](#system-architecture)
3. [Tech Stack](#tech-stack)
4. [Folder Structure](#folder-structure)
5. [Environment Variables](#environment-variables)
6. [NPM Scripts](#npm-scripts)
7. [Database Schema (Prisma 12-Model Summary)](#database-schema-prisma-12-model-summary)
8. [Authentication, Authorization & Security](#authentication-authorization--security)
   - [Domain-Based Institutional Gating](#1-domain-based-institutional-gating)
   - [Section & Class Capacity Restrictions](#2-section--class-capacity-restrictions)
   - [Auto-Assigned Sequential Roll Numbers](#3-auto-assigned-sequential-roll-numbers)
   - [Admin Approval Gate](#4-admin-approval-gate)
   - [Account Lockout Protection](#5-account-lockout-protection)
   - [Two-Factor Authentication (TOTP)](#6-two-factor-authentication-totp)
   - [Demo Account Auto-Provisioning & Self-Healing](#7-demo-account-auto-provisioning--self-healing)
9. [Middleware Pipeline](#middleware-pipeline)
10. [Comprehensive API Endpoints Reference](#comprehensive-api-endpoints-reference)
    - [1. Authentication Routes (`/api/auth/*`)](#1-authentication-routes-apiauth)
    - [2. User & Profile Management (`/api`)](#2-user--profile-management-api)
    - [3. Admin Control Center (`/api/admin`)](#3-admin-control-center-apiadmin)
    - [4. Approval Gate Routes (`/api`)](#4-approval-gate-routes-api)
    - [5. Class & Subject Requests (`/api`)](#5-class--subject-requests-api)
    - [6. Assignment & Homework Management (`/api`)](#6-assignment--homework-management-api)
    - [7. Attendance Tracking & Analytics (`/api`)](#7-attendance-tracking--analytics-api)
    - [8. Examinations & Schedules (`/api/exams`)](#8-examinations--schedules-apiexams)
    - [9. Results & Gradebook (`/api`)](#9-results--gradebook-api)
    - [10. Noticeboard & Announcements (`/api/notices`)](#10-noticeboard--announcements-apinotices)
    - [11. Password Reset Pipeline (`/api/password-reset`)](#11-password-reset-pipeline-apipassword-reset)
    - [12. System Health & Diagnostics](#12-system-health--diagnostics)
11. [Cloudflare R2 File Storage](#cloudflare-r2-file-storage)
12. [Transactional Email Delivery](#transactional-email-delivery)
13. [Session & Token Verification Architecture](#session--token-verification-architecture)
14. [Deployment & Production Readiness](#deployment--production-readiness)

---

## Executive Summary

**EduNexus Server** is an institutional education platform backend designed to handle school administration, teacher workflows, and student activities in a secure, multi-tenant environment. 

### Core Capabilities

- **Institutional Identity Enforcement:** Strict domain gating automatically assigns roles based on email domain (`@edunexus.std.com` $\rightarrow$ student, `@edunexus.tchr.com` $\rightarrow$ teacher), rejecting unapproved public email addresses.
- **Academic Enrollment Controls:** Hard limits enforce maximum capacities (30 students per section, 60 per class/group) and automatically compute sequential roll numbers upon registration.
- **Admin Approval Gate:** New registrations default to `isApproved: false`, preventing access until verified and granted by an administrator.
- **Lockout & Two-Factor Security:** Account locking triggers after 3 failed password attempts (5-hour cooldown), with admin unlock overrides and TOTP 2FA.
- **Academic Management Workflows:**
  - **Assignments:** Teacher creation, status toggles (ACTIVE/DRAFT/CLOSED), Cloudflare R2 PDF file uploads, attempt counting (capped at 2), grading, and feedback.
  - **Attendance:** Section-specific daily rosters (PRESENT, LATE, ABSENT), date-range filtering, at-risk student detection (< 75% attendance rate), and weekday trend analytics.
  - **Examinations & Results:** Exam scheduling, invigilator assignments, and draft-to-published grading reports for students and parents.
  - **Class & Subject Requests:** Formal pipeline for teachers to request specific grades, sections, and subjects, with auto-assignment upon admin approval.
  - **Announcements:** School-wide noticeboard with category tags, pinning priorities, and role-based author restrictions.
  - **Financial Receipts:** Dynamic PDF tuition and fee receipt generator with print triggers.

---

## System Architecture

```
                                  ┌─────────────────────────────────────────┐
                                  │      Client Applications (Next.js)      │
                                  └────────────────────┬────────────────────┘
                                                       │ HTTPS (Cookies / Bearer)
                                                       ▼
┌───────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Express REST API (`src/index.ts` / `api/index.ts`)                                                    │
│                                                                                                       │
│  [CORS & Proxy Trust] ──▶ [Raw Body Stream] ──▶ [Better Auth Engine] (`/api/auth/*`)                  │
│                                   │                                                                   │
│                            [express.json()]                                                           │
│                                   │                                                                   │
│                 [Authentication & Role Guard Middleware]                                             │
│                     ├── `requireAuth` (Session/Cookie/Header)                                         │
│                     └── `requireRole("admin" | "teacher" | "student")`                                │
│                                   │                                                                   │
│      ┌────────────────────────────┼────────────────────────────┬────────────────────────────┐         │
│      ▼                            ▼                            ▼                            ▼         │
│ [User & Admin]            [Academic Core]             [Attendance & Exams]          [Notices & Auth]  │
│  • user.routes.ts          • assignment.routes.ts      • attendance.routes.ts        • notice.routes.ts│
│  • admin.routes.ts         • request.routes.ts         • exam.routes.ts              • password-reset  │
│  • approval.routes.ts      • result.routes.ts                                                         │
└───────────────────────────────────┬────────────────────────────┬────────────────────────────┬─────────┘
                                    │                            │                            │
                                    ▼                            ▼                            ▼
                         ┌─────────────────────┐      ┌────────────────────┐      ┌─────────────────────┐
                         │ Prisma ORM (Client) │      │  Cloudflare R2     │      │ SMTP Mailer Engine  │
                         │   MongoDB Atlas     │      │ S3 Object Storage  │      │     (Nodemailer)    │
                         └─────────────────────┘      └────────────────────┘      └─────────────────────┘
```

---

## Tech Stack

| Layer | Technology | Version | Purpose |
|---|---|---|---|
| **Runtime** | Node.js (ESM) | 20.x+ | Modern ES module execution |
| **Language** | TypeScript | 5.6.3 | Static typing, interface contracts |
| **Web Framework** | Express | 4.21.2 | REST API routing and middleware pipeline |
| **Authentication** | Better Auth | 1.7.1 | Session management, password hashing, TOTP 2FA plugin |
| **ORM** | Prisma Client & CLI | 6.18.0 | Type-safe database queries and MongoDB schema modeling |
| **Database** | MongoDB Atlas | 7.5.0 driver | Document database configured as a Replica Set |
| **Cloud Storage** | Cloudflare R2 | `@aws-sdk/client-s3` | S3-compatible cloud storage for avatars and assignment PDFs |
| **File Uploads** | Multer | 2.3.0 | Memory-buffered multipart file processing |
| **Email Transporter** | Nodemailer | 10.0.0 | Transactional notifications and password recovery links |
| **Hot Reload Tool** | `tsx` | 4.19.2 | Instant TypeScript watch server during local development |
| **Hosting Platform** | Vercel Serverless | `@vercel/node` | Serverless deployment via `api/index.ts` handler |

---

## Folder Structure

```
EduNexus-Server/
├── .env                             # Active environment variables (Git ignored)
├── .env.example                     # Reference template for all environment keys
├── .gitignore                       # Ignored build artifacts and node_modules
├── api/
│   └── index.ts                     # Vercel serverless function export
├── dist/                            # Compiled production JavaScript (from tsc)
├── prisma/
│   └── schema.prisma                # Prisma MongoDB schema definition (12 models)
├── src/
│   ├── index.ts                     # Express app setup, CORS, route registry, /health
│   ├── lib/
│   │   ├── auth.ts                  # Better Auth configuration, hooks, roll assignment, lockout
│   │   ├── mailer.ts                # Nodemailer SMTP transporter and email templates
│   │   ├── prisma.ts                # Singleton PrismaClient instance
│   │   └── r2.ts                    # Cloudflare R2 client, Multer configs, upload helpers
│   ├── middleware/
│   │   └── session.ts               # requireAuth and requireRole middleware definitions
│   └── routes/
│       ├── admin.routes.ts          # System stats, user CRUD, role updates, account unlock, PDF receipt
│       ├── approval.routes.ts       # Registration approval checking & admin approval actions
│       ├── assignment.routes.ts     # Student & teacher assignments, PDF uploads (max 2), grading
│       ├── attendance.routes.ts     # Student rosters, daily mark upsert, weekly trends, student history
│       ├── auth.routes.ts           # Better Auth route handler mount (/api/auth/*)
│       ├── exam.routes.ts           # Exam schedule creation, listing, cancellation
│       ├── notice.routes.ts         # School-wide announcements, pinned priority, CRUD
│       ├── password-reset.routes.ts # TOTP authenticator-verified password reset pipeline
│       ├── request.routes.ts        # Teacher class/subject requests & student curriculum list
│       ├── result.routes.ts         # Student result creation, draft/published toggles, student view
│       └── user.routes.ts           # Profile get/put, avatar R2 upload, student list, email check
├── package.json                     # Project scripts and dependencies
├── tsconfig.json                    # TypeScript compiler configuration
└── vercel.json                      # Vercel routing and serverless function rewrite rules
```

---

## Environment Variables

| Variable | Required | Description | Example |
|---|:---:|---|---|
| `PORT` | No | Express server listener port (defaults to 5000) | `5000` |
| `DATABASE_URL` | **Yes** | MongoDB connection string pointing to a replica set | `mongodb+srv://user:pass@cluster.mongodb.net/edunexus` |
| `BETTER_AUTH_SECRET` | **Yes** | 32-byte secret for encrypting cookies and sessions | Base64 string |
| `BETTER_AUTH_URL` | **Yes** | Public base URL of this server | `http://localhost:5000` or `https://api.edunexus.com` |
| `CLIENT_ORIGIN` | **Yes** | Allowed frontend origins (comma-separated for multiple) | `http://localhost:3000,http://localhost:5000` |
| `NODE_ENV` | No | Node execution environment | `development` or `production` |
| `R2_ACCOUNT_ID` | **Yes** | Cloudflare account ID | `a1b2c3d4e5f6g7h8...` |
| `R2_ACCESS_KEY_ID` | **Yes** | Cloudflare R2 S3 access key ID | `0123456789abcdef...` |
| `R2_SECRET_ACCESS_KEY` | **Yes** | Cloudflare R2 S3 secret access key | `9876543210fedcba...` |
| `R2_BUCKET_NAME` | **Yes** | R2 bucket name | `edunexus-bucket` |
| `R2_PUBLIC_URL` | **Yes** | Public custom domain or r2.dev URL for the bucket | `https://assets.edunexus.com` |
| `SMTP_HOST` | No | SMTP host for outgoing notification emails | `smtp.gmail.com` |
| `SMTP_PORT` | No | SMTP port (465 for TLS, 587 for STARTTLS) | `587` |
| `SMTP_USER` | No | SMTP username | `noreply@edunexus.com` |
| `SMTP_PASS` | No | SMTP password or app-specific password | `xxxx xxxx xxxx xxxx` |
| `SMTP_FROM` | No | Outgoing sender display and address | `EduNexus <noreply@edunexus.com>` |

---

## NPM Scripts

```bash
npm run dev             # Start development server with live tsx hot-reloading
npm run build           # Run prisma generate followed by TypeScript compilation (tsc)
npm run start           # Run production compiled server from dist/index.js
npm run prisma:generate # Re-generate Prisma Client types from prisma/schema.prisma
npm run prisma:push     # Synchronize schema directly to MongoDB without migrations
npm run postinstall     # Automatically invoked by Vercel/NPM to generate Prisma client
```

---

## Database Schema (Prisma 12-Model Summary)

### 1. `User` (`users` collection)
Central identity model for all actors (Admins, Teachers, Students).
- **Core Identity:** `id` (ObjectId), `name`, `email` (unique), `emailVerified`, `image`, `role` (`"admin"` | `"teacher"` | `"student"`).
- **Security & Status:** `failedLoginAttempts` (default 0), `lockedUntil` (DateTime?), `twoFactorEnabled` (Boolean), `isApproved` (Boolean).
- **Personal Details:** `phone`, `location`, `department`, `bio`, `fatherName`, `motherName`, `dateOfBirth`, `address`, `bloodGroup`, `gender` ("Male" | "Female" | "Other"), `guardianPhone`, `guardianRelation`.
- **Student Academic Profile:** `schoolName`, `studentClass`, `studentSection`, `sessionYear`, `group` ("Science" | "Business Studies" | "Humanities"), `roll` (sequential auto-generated).
- **Teacher Profile:** `qualification`.
- **Indexes:** `@@index([studentClass, studentSection, group])`.

### 2. `Session` (`sessions` collection)
Stores active Better Auth login sessions.
- `id` (ObjectId), `token` (unique), `expiresAt`, `ipAddress`, `userAgent`, `userId` (FK $\rightarrow$ `User`), `createdAt`, `updatedAt`.

### 3. `Account` (`accounts` collection)
Stores credential records and hashed passwords.
- `id` (ObjectId), `accountId`, `providerId`, `password` (hashed), `userId` (FK $\rightarrow$ `User`).

### 4. `Verification` (`verifications` collection)
Stores temporary tokens for verification workflows.
- `id` (ObjectId), `identifier`, `value`, `expiresAt`, `createdAt`, `updatedAt`.

### 5. `TwoFactor` (`two_factors` collection)
Stores authenticator app TOTP secrets and recovery codes.
- `id` (ObjectId), `secret` (AES encrypted), `backupCodes`, `verified` (Boolean), `failedVerificationCount`, `lockedUntil`, `userId` (FK $\rightarrow$ `User`).

### 6. `Notice` (`notices` collection)
School-wide noticeboard announcements.
- `id` (ObjectId), `teacherName`, `title`, `detail`, `category` (default: "General"), `isPinned` (Boolean), `authorEmail` (FK $\rightarrow$ `User.email`), `createdAt`, `updatedAt`.

### 7. `ClassSubjectRequest` (`class_subject_requests` collection)
Teacher applications to instruct specific classes and subjects.
- `id` (ObjectId), `teacherEmail`, `teacherName`, `grade`, `section`, `subject`, `subjectCode`, `group`, `room`, `schedule`, `time`, `reason`, `status` (`"PENDING"` | `"APPROVED"` | `"REJECTED"`), `adminFeedback`.

### 8. `Assignment` (`assignments` collection)
Coursework and homework tasks created by teachers.
- `id` (ObjectId), `title`, `description`, `subject`, `grade`, `section`, `dueDate`, `totalMarks` (default 100), `status` (`"ACTIVE"` | `"DRAFT"` | `"CLOSED"`), `submitStatus` (`"PENDING"` | `"SUBMITTED"`), `teacherEmail`, `teacherName`.
- **Indexes:** `@@index([teacherEmail])`, `@@index([status])`, `@@index([dueDate])`.

### 9. `Submission` (`submissions` collection)
Student submissions for assignments.
- `id` (ObjectId), `assignmentId` (FK $\rightarrow$ `Assignment`), `studentId` (FK $\rightarrow$ `User`), `studentEmail`, `content`, `fileUrl` (Cloudflare R2 URL), `attemptsUsed` (max 2), `marks`, `status` (`"SUBMITTED"` | `"GRADED"` | `"LATE"`), `feedback`, `submittedAt`.
- **Constraint:** `@@unique([assignmentId, studentId])`.

### 10. `Exam` (`examinations` collection)
Official institutional examinations.
- `id` (ObjectId), `title`, `subject`, `studentClass`, `section` (default "Section A"), `group`, `examType` ("Class Test" | "Quiz" | "Mid-Term" | "Final Term"), `date` (YYYY-MM-DD), `startTime`, `endTime`, `roomNo`, `totalMarks`, `passingMarks`, `invigilator`, `isYourDuty`, `syllabus`, `status` ("Upcoming" | "Ongoing" | "Completed" | "Cancelled"), `teacherEmail`.
- **Indexes:** `@@index([studentClass])`, `@@index([status])`, `@@index([date])`.

### 11. `StudentResult` (`results` collection)
Official student gradebook entries.
- `id` (ObjectId), `studentId`, `studentName`, `studentEmail`, `studentClass`, `assignmentId` (optional), `exam`, `score`, `total`, `grade`, `status` (`"DRAFT"` | `"PUBLISHED"`).
- **Indexes:** `@@index([studentId])`, `@@index([studentEmail])`, `@@index([assignmentId])`, `@@index([status])`.

### 12. `Attendance` (`attendances` collection)
Daily student attendance records.
- `id` (ObjectId), `studentId` (FK $\rightarrow$ `User`), `studentEmail`, `studentName`, `teacherEmail`, `grade` (Class 6 - Class 10), `section` (strictly "Section A" | "Section B"), `group`, `status` (`"PRESENT"` | `"LATE"` | `"ABSENT"`), `date` (normalized to local midnight).
- **Constraint:** `@@unique([studentId, date])`.
- **Indexes:** `@@index([teacherEmail])`, `@@index([grade, section])`, `@@index([date])`.

---

## Authentication, Authorization & Security

### 1. Domain-Based Institutional Gating
Implemented directly in the Better Auth `databaseHooks.user.create.before` lifecycle hook (`src/lib/auth.ts`):
- Emails ending with `@edunexus.std.com` $\rightarrow$ automatically assigned role: `"student"`.
- Emails ending with `@edunexus.tchr.com` $\rightarrow$ automatically assigned role: `"teacher"`.
- Any external domains (Gmail, Yahoo, etc.) are blocked with an HTTP 400 `NOT_INSTITUTION_EMAIL` error.

### 2. Section & Class Capacity Restrictions
During student sign-up, enrollment limits are verified before record creation:
- **Section Limit:** Maximum **30 students** per section (`SECTION_FULL`).
- **Class / Group Limit:** Maximum **60 students** across sections for the same class and department (`CLASS_FULL`).

### 3. Auto-Assigned Sequential Roll Numbers
Students do not select their own roll numbers. The system queries all existing students enrolled in that specific class and section, extracts the current highest numeric roll, and assigns `maxRoll + 1` automatically.

### 4. Admin Approval Gate
- Every new user is created with `isApproved: false` (except demo accounts).
- Better Auth's `autoSignIn: false` setting ensures newly registered users cannot access protected areas until an administrator approves them.
- Login pages poll `GET /api/approval-status?email=...` to display the account approval state.

### 5. Account Lockout Protection
- Tracks consecutive `failedLoginAttempts`.
- Upon reaching **3 consecutive failed attempts**, `lockedUntil` is set to **current time + 5 hours**.
- Subsequent login requests during lockout receive HTTP 403 specifying the remaining duration.
- Successful login resets `failedLoginAttempts: 0` and `lockedUntil: null`.
- Admins can immediately unlock accounts via `PATCH /api/admin/users/:id/unlock`.

### 6. Two-Factor Authentication (TOTP)
- Uses standard RFC 6238 TOTP algorithms compatible with Google Authenticator, Microsoft Authenticator, and 1Password.
- Secret keys are stored securely using AES symmetric encryption.
- Admins can override and reset a locked user's 2FA using `POST /api/admin/reset-2fa`.

### 7. Demo Account Auto-Provisioning & Self-Healing
Special demo accounts are pre-configured:
- `demostudent@edunexus.std.com` (Password: `demostudent1234`)
- `demoteacher@edunexus.tchr.com` (Password: `demoteacher1234`)
Whenever either demo account signs in, the server automatically verifies its existence, ensures `isApproved: true`, removes any lockouts, and disables 2FA challenges.

---

## Middleware Pipeline

### `requireAuth` (`src/middleware/session.ts`)
- Calls `auth.api.getSession({ headers: fromNodeHeaders(req.headers) })`.
- Accepts either native `httpOnly` session cookies (`better-auth.session_token`) or HTTP `Authorization: Bearer <token>` headers.
- Populates `req.user` and `req.session` on success; returns `401 Unauthorized` on failure.

### `requireRole(...roles)` (`src/middleware/session.ts`)
- Executed immediately following `requireAuth`.
- Inspects `req.user.role` against authorized roles (e.g., `"admin"`, `"teacher"`, `"student"`).
- Rejects unauthorized users with `403 Forbidden`.

---

## Comprehensive API Endpoints Reference

### 1. Authentication Routes (`/api/auth/*`)
Handled by Better Auth mounted at `/api/auth`:

| Method | Endpoint | Access | Description |
|---|---|:---:|---|
| `POST` | `/api/auth/sign-up/email` | Public | Register new institutional user (`name`, `email`, `password`, profile fields) |
| `POST` | `/api/auth/sign-in/email` | Public | Authenticate with institutional email & password |
| `POST` | `/api/auth/sign-out` | Authenticated | Terminate session and invalidate auth cookies |
| `GET` | `/api/auth/get-session` | Authenticated | Retrieve active user and session metadata |
| `POST` | `/api/auth/two-factor/enable` | Authenticated | Initialize TOTP and retrieve QR code / secret |
| `POST` | `/api/auth/two-factor/verify-totp` | Authenticated | Verify 6-digit TOTP code to complete 2FA login |
| `POST` | `/api/auth/two-factor/disable` | Authenticated | Disable 2FA for the authenticated account |

---

### 2. User & Profile Management (`/api`)

| Method | Endpoint | Access | Description |
|---|---|:---:|---|
| `GET` | `/api/me` | Authenticated | Retrieve current user profile with extended academic details |
| `PUT` | `/api/user/profile` | Authenticated | Update user profile, contact, personal, or academic information |
| `POST` | `/api/user/profile/image` | Authenticated | Upload profile avatar (max 5MB, JPEG/PNG/WebP/GIF) to Cloudflare R2 |
| `GET` | `/api/user/check-exists` | Public | Check if an email already exists (`?email=...`) prior to sign-up |
| `GET` | `/api/teacher/students` | Teacher / Admin | Paginated list of students (`?page&limit&search&studentClass&group`) |
| `GET` | `/api/admin/user-2fa-status` | Admin | Query TOTP 2FA enabled status for a given `?email=...` |
| `POST` | `/api/admin/reset-2fa` | Admin | Emergency reset of 2FA for a user (`{ email }`) |
| `GET` | `/api/admin/overview` | Admin | Diagnostic welcome verification route |

---

### 3. Admin Control Center (`/api/admin`)

| Method | Endpoint | Access | Description |
|---|---|:---:|---|
| `GET` | `/api/admin/stats` | Admin | Aggregated dashboard metrics (users, roles, locked, pending, assignments, results, exams) |
| `GET` | `/api/admin/users` | Admin | Paginated, filtered user list (`?page&limit&search&role&isApproved&isLocked`) |
| `GET` | `/api/admin/teachers` | Admin | Fetch all approved teachers for assignment dropdowns |
| `PATCH` | `/api/admin/users/:id/role` | Admin | Change user role (`student` \| `teacher` \| `admin`) |
| `PATCH` | `/api/admin/users/:id` | Admin | Update user information, assigned class, section, or approval |
| `PATCH` | `/api/admin/users/:id/disapprove` | Admin | Revoke user access by setting `isApproved = false` |
| `PATCH` | `/api/admin/users/:id/unlock` | Admin | Reset lockout counter and timer for a locked user |
| `DELETE` | `/api/admin/users/:id` | Admin | Permanently delete user and cascade associated records |
| `POST` | `/api/admin/receipts/generate-pdf` | Admin | Generate dynamic official printable fee receipt HTML/PDF |

---

### 4. Approval Gate Routes (`/api`)

| Method | Endpoint | Access | Description |
|---|---|:---:|---|
| `GET` | `/api/approval-status` | Public | Check if an email is approved (`?email=...`) before sign-in |
| `GET` | `/api/admin/pending-users` | Admin | Retrieve all registered users waiting for admin approval |
| `POST` | `/api/admin/approve-user` | Admin | Approve pending user account (`{ userId }`) |

---

### 5. Class & Subject Requests (`/api`)

| Method | Endpoint | Access | Description |
|---|---|:---:|---|
| `GET` | `/api/teacher/requests` | Teacher / Admin | List class/subject assignment requests (`?status=...`) |
| `POST` | `/api/teacher/requests` | Teacher / Admin | Submit a request for grade, section, subject, and schedule |
| `DELETE` | `/api/teacher/requests/:id` | Teacher (own) / Admin | Cancel a pending request |
| `PATCH` | `/api/admin/requests/:id` | Admin | Approve or reject a request with optional feedback |
| `GET` | `/api/student/subjects` | Student | Return approved subjects, teachers, and timetable for student's class |

---

### 6. Assignment & Homework Management (`/api`)

| Method | Endpoint | Access | Description |
|---|---|:---:|---|
| `GET` | `/api/student/assignments` | Student | List active assignments matching student's grade & section with submission status |
| `POST` | `/api/student/assignments/:id/upload` | Student | Upload assignment PDF to R2 (strictly 2 attempts max, max 10MB) |
| `POST` | `/api/student/assignments/:id/submit` | Student | Submit assignment content or file link (auto-flags LATE if past due date) |
| `GET` | `/api/teacher/assignments` | Teacher / Admin | List assignments created by teacher (`?status=ACTIVE`) |
| `GET` | `/api/teacher/assignments/:id/submissions` | Teacher / Admin | View all student submissions for a specific assignment |
| `POST` | `/api/teacher/assignments` | Teacher / Admin | Create a new assignment with due date and total marks |
| `PATCH` | `/api/teacher/assignments/:id` | Teacher (creator) / Admin | Update assignment metadata, total marks, or status |
| `DELETE` | `/api/teacher/assignments/:id` | Teacher (creator) / Admin | Delete an assignment and related submissions |

---

### 7. Attendance Tracking & Analytics (`/api`)

| Method | Endpoint | Access | Description |
|---|---|:---:|---|
| `GET` | `/api/teacher/attendance/students` | Teacher / Admin | Get student roster with marked attendance, attendance rate %, and at-risk flag |
| `POST` | `/api/teacher/attendance/mark` | Teacher / Admin | Upsert batch attendance records (`PRESENT`, `LATE`, `ABSENT`) for class/section |
| `GET` | `/api/teacher/attendance/stats` | Teacher / Admin | Aggregate attendance statistics: daily counts, weekly trends, class-by-class rates |
| `GET` | `/api/student/attendance` | Student | Retrieve student's personal attendance history and overall attendance percentage |

---

### 8. Examinations & Schedules (`/api/exams`)

| Method | Endpoint | Access | Description |
|---|---|:---:|---|
| `GET` | `/api/exams` | Public | List all scheduled exams (newest first) |
| `POST` | `/api/exams` | Public / Teacher | Schedule a new exam (subject, class, section, date, time, room, marks) |
| `PATCH` | `/api/exams/:id/cancel` | Public / Admin | Mark an exam status as `"Cancelled"` |

---

### 9. Results & Gradebook (`/api`)

| Method | Endpoint | Access | Description |
|---|---|:---:|---|
| `POST` | `/api/teacher/results` | Teacher / Admin | Create a new student result entry (`DRAFT` or `PUBLISHED`) |
| `GET` | `/api/teacher/results` | Authenticated | Filter results by `?studentEmail`, `?status`, or `?assignmentId` |
| `PATCH` | `/api/teacher/results/:id` | Teacher / Admin | Update score, total, grade, or status of an existing result |
| `DELETE` | `/api/teacher/results/:id` | Teacher / Admin | Delete a result entry |
| `GET` | `/api/student/results` | Student | List all published results for the authenticated student |
| `GET` | `/api/student/results/:id` | Student | View a specific published result detail |

---

### 10. Noticeboard & Announcements (`/api/notices`)

| Method | Endpoint | Access | Description |
|---|---|:---:|---|
| `GET` | `/api/notices` | Public | List notices ordered by pinned priority first, then creation date |
| `POST` | `/api/notices` | Teacher / Admin | Publish a new notice (supports category and `isPinned` flag) |
| `PUT` | `/api/notices/:id` | Teacher (author) / Admin | Update notice content, category, or pinned status |
| `DELETE` | `/api/notices/:id` | Teacher (author) / Admin | Remove a notice from the noticeboard |

---

### 11. Password Reset Pipeline (`/api/password-reset`)

| Method | Endpoint | Access | Description |
|---|---|:---:|---|
| `POST` | `/api/password-reset/verify-code` | Public | Step 1: Verify email + TOTP 6-digit authenticator code; returns 5-min `resetToken` |
| `POST` | `/api/password-reset/set-password` | Public | Step 2: Redeem single-use `resetToken` to set new password ($\ge$ 8 chars) |

---

### 12. System Health & Diagnostics

| Method | Endpoint | Access | Description |
|---|---|:---:|---|
| `GET` | `/health` | Public | Proactive database connectivity check via `prisma.$connect()` |
| `GET` | `/` | Public | API root identifier confirming server availability |

---

## Cloudflare R2 File Storage

Cloudflare R2 provides zero-egress-fee, S3-compatible cloud object storage configured via `@aws-sdk/client-s3` (`src/lib/r2.ts`).

### Storage Policies & Upload Specs

- **Profile Avatars:**
  - MIME types allowed: `image/jpeg`, `image/png`, `image/webp`, `image/gif`
  - Max File Size: **5 MB**
  - R2 Key Pattern: `profile-images/${userId}/${uuid}.${extension}`
- **Assignment Submissions:**
  - MIME types allowed: `application/pdf`
  - Magic Byte Validation: Must start with binary `%PDF-` (`0x25 0x50 0x44 0x46 0x2D`)
  - Max File Size: **10 MB**
  - Submission Limit: Strictly capped at **2 attempts** per student per assignment
  - R2 Key Pattern: `submissions/${userId}/${assignmentId}/${uuid}.pdf`

---

## Transactional Email Delivery

Configured using Nodemailer (`src/lib/mailer.ts`):
- **Transport:** Standard SMTP over port 587 (STARTTLS) or 465 (SSL/TLS).
- **Graceful Fallback:** If `SMTP_HOST` is omitted (local dev), the reset link is printed directly to the terminal stdout for testing.
- **Email Types:** Password reset instructions with 15-minute validity windows.

---

## Session & Token Verification Architecture

EduNexus Server supports both **Cookie-Based** and **Header-Based** authentication:

```
                      Client Request
                            │
             Does it have Cookies or Bearer?
             ├── Cookie: better-auth.session_token
             └── Header: Authorization: Bearer <token>
                            │
                            ▼
              Better Auth: `fromNodeHeaders`
                            │
            ┌───────────────┴───────────────┐
            ▼                               ▼
     Valid Session                  Missing / Expired
   Attach `req.user` &              Return 401 JSON:
   `req.session` ──▶ Next()         { "error": "Unauthorized" }
```

### Client Header Usage (No-Cookie Flow)
When third-party cookies are blocked or when calling from non-browser clients (mobile / Postman):
```javascript
fetch("http://localhost:5000/api/me", {
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`
  }
});
```

---

## Deployment & Production Readiness

### 1. Vercel Serverless Function
- `api/index.ts` imports the Express application and exports it directly as the Vercel Node handler.
- `vercel.json` routes all inbound requests to the serverless function:
  ```json
  {
    "version": 2,
    "rewrites": [
      { "source": "/(.*)", "destination": "/api" }
    ]
  }
  ```

### 2. Standalone Node.js Container / VPS
- In standard Node environments, `src/index.ts` automatically binds to `PORT` (or 5000) and prints a health check URL.
- `app.set("trust proxy", 1)` is enabled to ensure correct IP resolution and HTTPS redirection behind reverse proxies (Nginx, Traefik, Cloudflare).

---

*Last Updated: September 2026*
