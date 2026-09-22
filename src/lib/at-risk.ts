export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "INSUFFICIENT_DATA";

export interface AtRiskInput {
  attendanceTotal: number;
  attendancePresentOrLate: number;
  resultsCount: number;
  averageScorePercent: number | null; // null when resultsCount === 0
  assignmentsAssigned: number;
  assignmentsSubmitted: number;
}

export interface AtRiskScore {
  riskLevel: RiskLevel;
  attendanceRate: number | null;
  averageScorePercent: number | null;
  assignmentCompletionRate: number | null;
  reasons: string[]; // plain-language factors, shown directly in the UI
}

// Minimum records before a dimension is trusted enough to score — a
// student with 1 attendance record marked ABSENT is not "0% attendance
// risk", they just don't have enough history yet.
const MIN_ATTENDANCE_RECORDS = 3;
const MIN_RESULTS = 1;
const MIN_ASSIGNMENTS_ASSIGNED = 1;

export function computeAtRiskScore(input: AtRiskInput): AtRiskScore {
  const reasons: string[] = [];
  let points = 0;
  let scoredDimensions = 0;

  let attendanceRate: number | null = null;
  if (input.attendanceTotal > 0) {
    attendanceRate = Math.round(
      (input.attendancePresentOrLate / input.attendanceTotal) * 100
    );
    if (input.attendanceTotal >= MIN_ATTENDANCE_RECORDS) {
      scoredDimensions += 1;
      if (attendanceRate < 75) {
        points += 2;
        reasons.push(`Attendance is ${attendanceRate}%, below the 75% threshold.`);
      } else if (attendanceRate < 85) {
        points += 1;
        reasons.push(`Attendance is ${attendanceRate}%, trending low.`);
      }
    }
  }

  let averageScorePercent: number | null = null;
  if (input.resultsCount >= MIN_RESULTS && input.averageScorePercent !== null) {
    averageScorePercent = Math.round(input.averageScorePercent);
    scoredDimensions += 1;
    if (averageScorePercent < 50) {
      points += 2;
      reasons.push(`Average exam score is ${averageScorePercent}%, below passing range.`);
    } else if (averageScorePercent < 65) {
      points += 1;
      reasons.push(`Average exam score is ${averageScorePercent}%, below class average.`);
    }
  }

  let assignmentCompletionRate: number | null = null;
  if (input.assignmentsAssigned >= MIN_ASSIGNMENTS_ASSIGNED) {
    assignmentCompletionRate = Math.round(
      (input.assignmentsSubmitted / input.assignmentsAssigned) * 100
    );
    scoredDimensions += 1;
    if (assignmentCompletionRate < 50) {
      points += 2;
      reasons.push(`Only ${assignmentCompletionRate}% of assignments submitted.`);
    } else if (assignmentCompletionRate < 75) {
      points += 1;
      reasons.push(`${assignmentCompletionRate}% of assignments submitted, some missing.`);
    }
  }

  if (scoredDimensions === 0) {
    return {
      riskLevel: "INSUFFICIENT_DATA",
      attendanceRate,
      averageScorePercent,
      assignmentCompletionRate,
      reasons: ["Not enough recorded attendance, results, or assignment data yet."],
    };
  }

  const riskLevel: RiskLevel = points >= 4 ? "HIGH" : points >= 2 ? "MEDIUM" : "LOW";

  if (reasons.length === 0) {
    reasons.push("No concerning factors found across attendance, results, or assignments.");
  }

  return { riskLevel, attendanceRate, averageScorePercent, assignmentCompletionRate, reasons };
}