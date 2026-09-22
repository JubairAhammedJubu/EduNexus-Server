import { Router } from "express";
import { Attendance } from "@prisma/client";
import { requireAuth, requireRole } from "../middleware/session.js";
import { prisma } from "../lib/prisma.js";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../lib/auth.js";

const router = Router();
const teacherOnly = [requireAuth, requireRole("teacher", "admin")];

const ALLOWED_SECTIONS = ["Section A", "Section B", "A", "B"];
const OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/;

/**
 * Normalizes any date string or Date object to local Midnight (00:00:00.000)
 * to avoid timezone offset discrepancies between server and database.
 */
function normalizeDate(dateInput?: string | Date): Date {
  if (!dateInput) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (dateInput instanceof Date) {
    const d = new Date(dateInput);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  const str = String(dateInput).trim();
  const parts = str.split("-");
  if (parts.length === 3) {
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1;
    const day = parseInt(parts[2], 10);
    if (!isNaN(year) && !isNaN(month) && !isNaN(day)) {
      return new Date(year, month, day, 0, 0, 0, 0);
    }
  }
  const d = new Date(str);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * GET /api/teacher/attendance/students
 *
 * Returns student roster filtered by grade, section (strictly Section A or B),
 * and group (department), along with attendance status for date/range.
 */
router.get(
  "/teacher/attendance/students",
  requireAuth,
  requireRole("teacher", "admin"),
  async (req, res) => {
    try {
      /**
       * =========================================================
       * AUTHENTICATED USER
       * =========================================================
       */
      const user = req.user;

      if (!user) {
        return res.status(401).json({
          success: false,
          error: "Unauthorized",
        });
      }

      const {
        grade,
        section,
        group,
        date,
        startDate,
        endDate,
      } = req.query;

      const filterGrade =
        typeof grade === "string"
          ? grade.trim()
          : "";

      const filterSection =
        typeof section === "string"
          ? section.trim()
          : "";

      const filterGroup =
        typeof group === "string"
          ? group.trim()
          : "";

      /**
       * =========================================================
       * DATE VALIDATION
       * =========================================================
       */
      let targetDateStart: Date;
      let targetDateEnd: Date;

      if (
        typeof startDate === "string" &&
        typeof endDate === "string" &&
        startDate &&
        endDate
      ) {
        targetDateStart = normalizeDate(startDate);
        targetDateEnd = normalizeDate(endDate);

        targetDateEnd.setHours(
          23,
          59,
          59,
          999
        );

        if (
          isNaN(targetDateStart.getTime()) ||
          isNaN(targetDateEnd.getTime())
        ) {
          return res.status(400).json({
            success: false,
            error: "Invalid date range.",
          });
        }

        if (targetDateStart > targetDateEnd) {
          return res.status(400).json({
            success: false,
            error:
              "startDate cannot be later than endDate.",
          });
        }
      } else {
        const queryDateStr =
          typeof date === "string"
            ? date.trim()
            : "";

        if (!queryDateStr) {
          return res.status(400).json({
            success: false,
            error: "Date is required.",
          });
        }

        targetDateStart =
          normalizeDate(queryDateStr);

        if (isNaN(targetDateStart.getTime())) {
          return res.status(400).json({
            success: false,
            error: "Invalid date.",
          });
        }

        targetDateEnd = new Date(
          targetDateStart
        );

        targetDateEnd.setDate(
          targetDateEnd.getDate() + 1
        );
      }

      /**
       * =========================================================
       * BASE STUDENT FILTER
       * =========================================================
       */
      const whereClause: any = {
        role: {
          in: ["student", "STUDENT"],
        },
      };

      /**
       * =========================================================
       * TEACHER ACCESS CONTROL
       * =========================================================
       *
       * Admin:
       *   Can access all students.
       *
       * Teacher:
       *   Can ONLY access students belonging to sections
       *   assigned to that teacher.
       *
       * Assignment source:
       *
       * ClassSection.teacherId -> User.id
       */
      if (user.role === "teacher") {
        const assignedSections =
          await prisma.classSection.findMany({
            where: {
              teacherId: user.id,
              isActive: true,
            },
            select: {
              name: true,
              schoolClass: {
                select: {
                  name: true,
                },
              },
            },
          });

        /**
         * Teacher has no assigned section.
         */
        if (assignedSections.length === 0) {
          return res.json({
            success: true,
            count: 0,
            students: [],
          });
        }

        /**
         * Normalize assigned class + section values.
         *
         * Example:
         *
         * Class 8 / Section A
         * Class 9 / Section B
         */
        const assignedSectionFilters =
          assignedSections.map((item) => ({
            studentClass:
              item.schoolClass.name,
            studentSection: item.name,
          }));

        /**
         * SECURITY:
         *
         * Teacher scope is ALWAYS applied.
         *
         * Query parameters cannot override this.
         */
        whereClause.AND = [
          {
            OR: assignedSectionFilters,
          },
        ];
      }

      /**
       * =========================================================
       * GRADE / CLASS FILTER
       * =========================================================
       */
      if (
        filterGrade &&
        filterGrade !== "All Classes"
      ) {
        /**
         * Supports:
         *
         * Class 8
         * Grade 8
         * 8
         */
        const cleanGrade = filterGrade
          .replace(
            /(Class|Grade)\s*/i,
            ""
          )
          .trim();

        const gradeValues = [
          filterGrade,
          `Class ${cleanGrade}`,
          `Grade ${cleanGrade}`,
          cleanGrade,
        ];

        if (!whereClause.AND) {
          whereClause.AND = [];
        }

        whereClause.AND.push({
          studentClass: {
            in: gradeValues,
          },
        });
      }

      /**
       * =========================================================
       * SECTION FILTER
       * =========================================================
       */
      if (
        filterSection &&
        filterSection !== "All Sections"
      ) {
        let sectionValues: string[];

        if (
          filterSection === "Section A" ||
          filterSection === "A"
        ) {
          sectionValues = [
            "Section A",
            "A",
          ];
        } else if (
          filterSection === "Section B" ||
          filterSection === "B"
        ) {
          sectionValues = [
            "Section B",
            "B",
          ];
        } else {
          return res.status(400).json({
            success: false,
            error:
              "Only Section A and Section B are allowed.",
          });
        }

        if (!whereClause.AND) {
          whereClause.AND = [];
        }

        whereClause.AND.push({
          studentSection: {
            in: sectionValues,
          },
        });
      }

      /**
       * =========================================================
       * GROUP FILTER
       * =========================================================
       */
      if (
        filterGroup &&
        filterGroup !== "All Groups" &&
        filterGroup !== "General"
      ) {
        if (!whereClause.AND) {
          whereClause.AND = [];
        }

        whereClause.AND.push({
          OR: [
            {
              group: {
                equals: filterGroup,
                mode: "insensitive",
              },
            },
            {
              department: {
                equals: filterGroup,
                mode: "insensitive",
              },
            },
          ],
        });
      }

      /**
       * =========================================================
       * FETCH STUDENTS
       * =========================================================
       */
      const students =
        await prisma.user.findMany({
          where: whereClause,

          select: {
            id: true,
            name: true,
            email: true,
            image: true,
            studentClass: true,
            studentSection: true,
            department: true,
            group: true,
            roll: true,
          },

          orderBy: {
            name: "asc",
          },
        });

      /**
       * =========================================================
       * VALID MONGODB OBJECT IDS
       * =========================================================
       */
      const validStudentIds =
        students
          .map((student) => student.id)
          .filter((id) =>
            OBJECT_ID_REGEX.test(id)
          );

      if (validStudentIds.length === 0) {
        return res.json({
          success: true,
          count: 0,
          students: [],
        });
      }

      /**
       * =========================================================
       * ATTENDANCE FOR TARGET DATE / RANGE
       * =========================================================
       */
      const existingAttendance =
        await prisma.attendance.findMany({
          where: {
            studentId: {
              in: validStudentIds,
            },
            date: {
              gte: targetDateStart,
              lt: targetDateEnd,
            },
          },

          orderBy: {
            date: "desc",
          },
        });

      /**
       * =========================================================
       * ATTENDANCE MAP
       * =========================================================
       */
      const attendanceMap = new Map<
        string,
        {
          status: string;
          updatedAt: Date;
        }
      >();

      existingAttendance.forEach(
        (attendance) => {
          /**
           * Keep the latest record for each student.
           */
          if (
            !attendanceMap.has(
              attendance.studentId
            )
          ) {
            attendanceMap.set(
              attendance.studentId,
              {
                status: attendance.status,
                updatedAt:
                  attendance.updatedAt,
              }
            );
          }
        }
      );

      /**
       * =========================================================
       * OVERALL ATTENDANCE STATISTICS
       * =========================================================
       */
      const allStudentRecords =
        await prisma.attendance.findMany({
          where: {
            studentId: {
              in: validStudentIds,
            },
          },

          select: {
            studentId: true,
            status: true,
          },
        });

      const statsMap = new Map<
        string,
        {
          total: number;
          present: number;
        }
      >();

      allStudentRecords.forEach(
        (record) => {
          const current =
            statsMap.get(record.studentId) || {
              total: 0,
              present: 0,
            };

          current.total += 1;

          if (
            record.status === "PRESENT" ||
            record.status === "LATE"
          ) {
            current.present += 1;
          }

          statsMap.set(
            record.studentId,
            current
          );
        }
      );

      /**
       * =========================================================
       * ENRICH STUDENT DATA
       * =========================================================
       */
      const enrichedStudents =
        students.map((student) => {
          const attendance =
            attendanceMap.get(student.id);

          const overall =
            statsMap.get(student.id) || {
              total: 0,
              present: 0,
            };

          const attendanceRate =
            overall.total > 0
              ? Math.round(
                  (overall.present /
                    overall.total) *
                    100
                )
              : 100;

          const isAtRisk =
            overall.total >= 3 &&
            attendanceRate < 75;

          return {
            ...student,

            status: attendance
              ? attendance.status
              : "NOT_MARKED",

            isMarked: !!attendance,

            updatedAt:
              attendance?.updatedAt || null,

            attendanceRate,

            totalClassesRecorded:
              overall.total,

            isAtRisk,
          };
        });

      /**
       * =========================================================
       * RESPONSE
       * =========================================================
       */
      return res.json({
        success: true,
        count: enrichedStudents.length,
        students: enrichedStudents,
      });
    } catch (error: any) {
      console.error(
        "Error fetching students for attendance:",
        error
      );

      return res.status(500).json({
        success: false,
        error:
          error?.message ||
          "Failed to fetch student roster",
      });
    }
  }
);

/**
 * POST /api/teacher/attendance/mark
 *
 * Saves/updates attendance records for a list of students for a specified date,
 * class, section (strictly Section A or B), and group.
 */
router.post(
  "/teacher/attendance/mark",
...teacherOnly,
  async (req, res) => {
    try {
      if (!req.user) {
        try {
          const sessionResult = await auth.api.getSession({
            headers: fromNodeHeaders(req.headers),
          });
          if (sessionResult?.user) {
            req.user = sessionResult.user;
          }
        } catch {
          // ignore session extraction error
        }
      }

      const { date, grade, section, group, records } = req.body;

      if (!grade || !section || !records || !Array.isArray(records)) {
        return res.status(400).json({
          success: false,
          error: "Grade, section, and records array are required.",
        });
      }

      if (!ALLOWED_SECTIONS.includes(section)) {
        return res.status(400).json({
          success: false,
          error: "Only Section A and Section B are allowed.",
        });
      }

      const targetDate = normalizeDate(date);
      const teacherEmail =
        (req.user as { email?: string } | undefined)?.email ||
        "demoteacher@edunexus.tchr.com";

      const upsertPromises = records.map(
        async (rec: {
          studentId?: string;
          studentEmail?: string;
          studentName?: string;
          status?: string;
        }) => {
          const { studentId, studentEmail, studentName, status } = rec;
          if (!studentId || !status) return null;

          // Ensure valid MongoDB ObjectId format
          if (!OBJECT_ID_REGEX.test(studentId)) {
            console.warn(`Skipping invalid studentId format: ${studentId}`);
            return null;
          }

          const validStatus = ["PRESENT", "LATE", "ABSENT"].includes(status)
            ? status
            : "PRESENT";

          return prisma.attendance.upsert({
            where: {
              studentId_date: {
                studentId,
                date: targetDate,
              },
            },
            create: {
              studentId,
              studentEmail: studentEmail || "",
              studentName: studentName || "Student",
              teacherEmail,
              grade: grade.trim(),
              section: section.trim(),
              group: group?.trim() || null,
              status: validStatus,
              date: targetDate,
            },
            update: {
              status: validStatus,
              teacherEmail,
              grade: grade.trim(),
              section: section.trim(),
              group: group?.trim() || null,
              updatedAt: new Date(),
            },
          });
        }
      );

      const results = await Promise.all(upsertPromises.filter(Boolean));

      return res.status(201).json({
        success: true,
        message: `Attendance marked successfully for ${results.filter(Boolean).length} students.`,
      });
    } catch (error: any) {
      console.error("Error marking attendance:", error);
      return res.status(500).json({
        success: false,
        error: error?.message || "Failed to mark attendance",
      });
    }
  }
);

/**
 * GET /api/teacher/attendance/stats
 *
 * Calculates dynamic real-time attendance stats:
 * Total students, Present, Late, Absent, Weekly trends, Class attendance rates (Section A & B).
 */
router.get(
  "/teacher/attendance/stats",
  ...teacherOnly,
  async (req, res) => {
    try {
      const today = normalizeDate();
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      // Total registered students enrolled in the school
      const totalStudentsCount = await prisma.user.count({
        where: {
          role: { in: ["student", "STUDENT"] },
        },
      });

      // Today's attendance records
      const todayAttendances = await prisma.attendance.findMany({
        where: {
          date: {
            gte: today,
            lt: tomorrow,
          },
          section: { in: ALLOWED_SECTIONS },
        },
      });

      let presentCount = 0;
      let lateCount = 0;
      let absentCount = 0;

      todayAttendances.forEach((att: Attendance) => {
        if (att.status === "PRESENT") presentCount++;
        else if (att.status === "LATE") lateCount++;
        else if (att.status === "ABSENT") absentCount++;
      });

      const totalMarkedToday = todayAttendances.length;
      const baseTotal = totalMarkedToday > 0 ? totalMarkedToday : totalStudentsCount;

      const presentRate =
        baseTotal > 0 ? ((presentCount / baseTotal) * 100).toFixed(1) : "0.0";
      const lateRate =
        baseTotal > 0 ? ((lateCount / baseTotal) * 100).toFixed(1) : "0.0";
      const absentRate =
        baseTotal > 0 ? ((absentCount / baseTotal) * 100).toFixed(1) : "0.0";

      // Calculate weekly attendance (Mon to Fri of current week)
      const currentDayOfWeek = today.getDay(); // 0 = Sun, 1 = Mon ...
      const distanceToMon = (currentDayOfWeek + 6) % 7; // distance from Mon
      const mondayDate = new Date(today);
      mondayDate.setDate(today.getDate() - distanceToMon);

      const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri"];
      const weeklyAttendance = await Promise.all(
        weekdays.map(async (dayName, i) => {
          const dayStart = new Date(mondayDate);
          dayStart.setDate(mondayDate.getDate() + i);
          const dayEnd = new Date(dayStart);
          dayEnd.setDate(dayStart.getDate() + 1);

          const dayRecords = await prisma.attendance.findMany({
            where: {
              date: { gte: dayStart, lt: dayEnd },
              section: { in: ALLOWED_SECTIONS },
            },
          });

          if (dayRecords.length === 0) {
            return { day: dayName, attendance: 0 };
          }

          const present = dayRecords.filter(
            (r: Attendance) => r.status === "PRESENT" || r.status === "LATE"
          ).length;
          const pct = Math.round((present / dayRecords.length) * 100);
          return { day: dayName, attendance: pct };
        })
      );

      // Class attendance rates (Grade 6 to Grade 10 for Section A and B)
      const targetClasses = [
        { grade: "Class 6", section: "Section A", name: "Grade 6 A" },
        { grade: "Class 6", section: "Section B", name: "Grade 6 B" },
        { grade: "Class 7", section: "Section A", name: "Grade 7 A" },
        { grade: "Class 7", section: "Section B", name: "Grade 7 B" },
        { grade: "Class 8", section: "Section A", name: "Grade 8 A" },
        { grade: "Class 8", section: "Section B", name: "Grade 8 B" },
        { grade: "Class 9", section: "Section A", name: "Grade 9 A" },
        { grade: "Class 9", section: "Section B", name: "Grade 9 B" },
        { grade: "Class 10", section: "Section A", name: "Grade 10 A" },
        { grade: "Class 10", section: "Section B", name: "Grade 10 B" },
      ];

      const classAttendance = await Promise.all(
        targetClasses.map(async (item) => {
          const cleanGrade = item.grade.replace(/(Class|Grade)\s*/i, "").trim();
          const classRecords = await prisma.attendance.findMany({
            where: {
              grade: { in: [item.grade, `Class ${cleanGrade}`, `Grade ${cleanGrade}`, cleanGrade] },
              section: { in: [item.section, item.section.replace("Section ", "")] },
            },
          });

          if (classRecords.length === 0) {
            return { name: item.name, attendance: 0 };
          }

          const present = classRecords.filter(
            (r: Attendance) => r.status === "PRESENT" || r.status === "LATE"
          ).length;
          const pct = Math.round((present / classRecords.length) * 100);
          return { name: item.name, attendance: pct };
        })
      );

      const distributionData = [
        { name: "Present", value: presentCount },
        { name: "Late", value: lateCount },
        { name: "Absent", value: absentCount },
      ];

      return res.json({
        success: true,
        stats: {
          totalStudents: totalStudentsCount,
          presentCount,
          presentRate,
          lateCount,
          lateRate,
          absentCount,
          absentRate,
          weeklyAttendance,
          classAttendance,
          distributionData,
        },
      });
    } catch (error: any) {
      console.error("Error fetching attendance stats:", error);
      return res.status(500).json({
        success: false,
        error: error?.message || "Failed to fetch attendance statistics",
      });
    }
  }
);

/**
 * GET /api/student/attendance
 *
 * Returns personal attendance history and attendance summary stats
 * for the authenticated student (or demo student).
 */
router.get(
  "/teacher/students",
  requireAuth,
  requireRole("teacher", "admin"),
  async (req, res) => {
    try {
      const user = req.user;

      if (!user) {
        return res.status(401).json({
          success: false,
          error: "Unauthorized",
        });
      }

      const page = Math.max(
        1,
        Number.parseInt(String(req.query.page || "1"), 10) || 1,
      );

      const limit = Math.min(
        100,
        Math.max(
          1,
          Number.parseInt(String(req.query.limit || "20"), 10) || 20,
        ),
      );

      const search = String(req.query.search || "").trim();
      const studentClass = String(req.query.studentClass || "").trim();
      const group = String(req.query.group || "").trim();

      const where: any = {
        role: "student",
      };

      // ============================================
      // TEACHER ACCESS CONTROL
      // ============================================

      if (user.role === "teacher") {
        const assignedSection = await prisma.classSection.findFirst({
          where: {
            teacherId: user.id,
            isActive: true,
          },
          select: {
            id: true,
            name: true,
            classId: true,
          },
        });

        if (!assignedSection) {
          return res.status(403).json({
            success: false,
            error: "You are not assigned as a class teacher.",
          });
        }

        const schoolClass = await prisma.schoolClass.findUnique({
          where: {
            id: assignedSection.classId,
          },
          select: {
            id: true,
            name: true,
          },
        });

        if (!schoolClass) {
          return res.status(404).json({
            success: false,
            error: "Assigned class not found.",
          });
        }

        // Teacher can only see assigned class + section students
        where.studentClass = schoolClass.name;
        where.studentSection = assignedSection.name;
      }

      // ============================================
      // ADMIN CLASS FILTER
      // ============================================

      if (
        user.role === "admin" &&
        studentClass &&
        studentClass !== "All Classes"
      ) {
        where.studentClass = {
          contains: studentClass,
          mode: "insensitive",
        };
      }

      // ============================================
      // GROUP FILTER
      // ============================================

      if (
        group &&
        group !== "All" &&
        group !== "All Groups"
      ) {
        where.group = {
          contains: group,
          mode: "insensitive",
        };
      }

      // ============================================
      // SEARCH
      // ============================================

      if (search) {
        where.OR = [
          {
            name: {
              contains: search,
              mode: "insensitive",
            },
          },
          {
            email: {
              contains: search,
              mode: "insensitive",
            },
          },
          {
            studentClass: {
              contains: search,
              mode: "insensitive",
            },
          },
          {
            studentSection: {
              contains: search,
              mode: "insensitive",
            },
          },
          {
            group: {
              contains: search,
              mode: "insensitive",
            },
          },
          {
            department: {
              contains: search,
              mode: "insensitive",
            },
          },
        ];
      }

      // ============================================
      // PAGINATION
      // ============================================

      const skip = (page - 1) * limit;

      const [totalCount, students] = await Promise.all([
        prisma.user.count({
          where,
        }),

        prisma.user.findMany({
          where,
          skip,
          take: limit,
          orderBy: {
            name: "asc",
          },
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
            studentClass: true,
            studentSection: true,
            group: true,
            department: true,
            phone: true,
            roll: true,
          },
        }),
      ]);

      // ============================================
      // FILTER OPTIONS SCOPE
      // ============================================

      const filterScope: any = {
        role: "student",
      };

      if (user.role === "teacher") {
        filterScope.studentClass = where.studentClass;
        filterScope.studentSection = where.studentSection;
      }

      const [distinctClasses, distinctGroups] = await Promise.all([
        prisma.user.findMany({
          where: filterScope,
          select: {
            studentClass: true,
          },
          distinct: ["studentClass"],
        }),

        prisma.user.findMany({
          where: filterScope,
          select: {
            group: true,
          },
          distinct: ["group"],
        }),
      ]);

      // ============================================
      // CLASS OPTIONS
      // ============================================

      const defaultClasses = [
        "All Classes",
        "Class 6",
        "Class 7",
        "Class 8",
        "Class 9",
        "Class 10",
      ];

      const classSet = new Set<string>(defaultClasses);

      distinctClasses.forEach((item) => {
        if (item.studentClass?.trim()) {
          classSet.add(item.studentClass.trim());
        }
      });

      // ============================================
      // GROUP OPTIONS
      // ============================================

      const defaultGroups = [
        "All Groups",
        "Science",
        "Business Studies",
        "Humanities",
      ];

      const groupSet = new Set<string>(defaultGroups);

      distinctGroups.forEach((item) => {
        if (item.group?.trim()) {
          groupSet.add(item.group.trim());
        }
      });

      // ============================================
      // PAGINATION INFO
      // ============================================

      const totalPages = Math.ceil(totalCount / limit) || 1;

      return res.json({
        success: true,
        students,
        pagination: {
          total: totalCount,
          page,
          limit,
          totalPages,
          hasNextPage: page < totalPages,
          hasPreviousPage: page > 1,
        },
        classes: Array.from(classSet),
        groups: Array.from(groupSet),
      });
    } catch (error: any) {
      console.error("Error fetching teacher students:", error);

      return res.status(500).json({
        success: false,
        error: error?.message || "Failed to fetch student list",
      });
    }
  },
);

export default router;