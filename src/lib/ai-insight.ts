const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

export type InsightPerspective = "teacher" | "student";
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

export interface PerformanceInsightRequest {
  studentName: string;
  /** "teacher": third-person note about the student, for a teacher to read.
   *  "student": second-person note written directly to the student. */
  perspective: InsightPerspective;
  riskLevel: RiskLevel;
  attendanceRate: number | null;
  averageScorePercent: number | null;
  assignmentCompletionRate: number | null;
  reasons: string[];
}

export interface GeneratedInsight {
  text: string;
  /** "groq" when a live LLM call produced the text, "fallback" when the
   *  deterministic, template-based generator did (no API key configured,
   *  or the API call failed) — the feature never hard-fails either way. */
  source: "groq" | "fallback";
}

function buildTeacherSystemPrompt(): string {
  return `You write short notes for teachers about a student's recent academic
signals (attendance, exam scores, assignment completion). These numbers
were already computed by the school system — you are not calculating
anything or diagnosing the student, only describing the pattern and
suggesting one practical, supportive next step a teacher could take.

Rules:
- 2-4 sentences, plain language, no bullet points, no headers.
- Never speculate about the student's character, intelligence, home life,
  or the cause behind the numbers — you don't know the cause.
- Frame it as "worth checking in on", never as a verdict or label.
- End with one concrete, low-stakes suggestion (e.g. a brief check-in
  conversation), not a demand for drastic action.
- Do not mention that you are an AI or that this is AI-generated.`;
}

function buildStudentSystemPrompt(): string {
  return `You write short, encouraging notes directly to a student about their
own recent academic signals (attendance, exam scores, assignment
completion). These numbers were already computed by the school system —
you are not calculating anything, only describing the pattern in a
supportive way and suggesting one concrete, doable next step.

Rules:
- 2-4 sentences, second person ("you"/"your"), plain and warm language,
  no bullet points, no headers.
- Never speculate about the student's character, intelligence, or home
  life — you don't know the cause behind the numbers.
- Never sound like a warning or verdict — sound like a coach.
- End with one concrete, achievable suggestion the student can act on
  this week.
- Do not mention that you are an AI or that this is AI-generated.`;
}

function buildUserPrompt(input: PerformanceInsightRequest): string {
  return `Student: ${input.studentName}
Risk level: ${input.riskLevel}
Attendance rate: ${input.attendanceRate !== null ? `${input.attendanceRate}%` : "not enough data"}
Average exam score: ${input.averageScorePercent !== null ? `${input.averageScorePercent}%` : "not enough data"}
Assignment completion: ${input.assignmentCompletionRate !== null ? `${input.assignmentCompletionRate}%` : "not enough data"}
Factors flagged: ${input.reasons.join(" ")}`;
}

async function callGroq(input: PerformanceInsightRequest, apiKey: string): Promise<string> {
  const systemPrompt =
    input.perspective === "student" ? buildStudentSystemPrompt() : buildTeacherSystemPrompt();

  const response = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: buildUserPrompt(input) },
      ],
      temperature: 0.4,
      max_tokens: 220,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Groq API request failed (${response.status}): ${errText.slice(0, 200)}`);
  }

  const data = (await response.json()) as any;
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Groq API returned an empty response.");
  }

  return content.trim();
}

/**
 * Deterministic, template-based note used whenever Groq isn't configured
 * (no GROQ_API_KEY) or a live call fails for any reason (network, quota,
 * outage). This is what makes the performance-insight feature always
 * runnable out of the box, with zero external setup required.
 */
function buildFallbackInsight(input: PerformanceInsightRequest): string {
  const isStudent = input.perspective === "student";

  const metricPhrases: string[] = [];
  if (input.attendanceRate !== null) metricPhrases.push(`attendance is at ${input.attendanceRate}%`);
  if (input.averageScorePercent !== null)
    metricPhrases.push(`the average exam score is ${input.averageScorePercent}%`);
  if (input.assignmentCompletionRate !== null)
    metricPhrases.push(`${input.assignmentCompletionRate}% of assignments have been submitted`);
  const metricsSentence = metricPhrases.length > 0 ? `Right now, ${metricPhrases.join(", and ")}.` : "";

  let openLine: string;
  let suggestion: string;

  if (input.riskLevel === "HIGH") {
    openLine = isStudent
      ? "A few things in your recent numbers are worth paying closer attention to."
      : `A few things in ${input.studentName}'s recent numbers are worth checking in on.`;
    suggestion = isStudent
      ? "A good next step could be picking just one area above and giving it extra focused time this week, and talking to a teacher if something's getting in the way."
      : "A brief, low-pressure check-in conversation could help surface what's getting in the way.";
  } else if (input.riskLevel === "MEDIUM") {
    openLine = isStudent
      ? "Your overall pattern looks reasonable, though a couple of areas are trending a little lower than usual."
      : `${input.studentName}'s overall pattern looks reasonable, though a couple of areas are trending a little lower than usual.`;
    suggestion = isStudent
      ? "Keeping an eye on those areas over the next couple of weeks should help keep things on track."
      : "It's probably not urgent, but keeping an eye on it over the next couple of weeks is a reasonable move.";
  } else {
    openLine = isStudent
      ? "Your recent numbers look solid across the board."
      : `${input.studentName}'s recent numbers look solid across the board.`;
    suggestion = isStudent
      ? "Keep doing what's working — consistency here is what tends to pay off over time."
      : "No action needed right now beyond the usual encouragement to keep it up.";
  }

  const reasonsSentence =
    input.reasons.length > 0 && input.riskLevel !== "LOW"
      ? ` Specifically: ${input.reasons.map((r) => r.replace(/\.$/, "")).join("; ")}.`
      : "";

  return [openLine, metricsSentence, suggestion].filter(Boolean).join(" ") + reasonsSentence;
}

/**
 * Generates a performance-insight note. Tries Groq first when
 * GROQ_API_KEY is configured; on any failure (missing key, network
 * error, bad response) it transparently falls back to a deterministic
 * template so callers never have to handle an "AI unavailable" error —
 * the feature always returns something useful.
 */
export async function generatePerformanceInsight(
  input: PerformanceInsightRequest
): Promise<GeneratedInsight> {
  const apiKey = process.env.GROQ_API_KEY;

  if (apiKey) {
    try {
      const text = await callGroq(input, apiKey);
      return { text, source: "groq" };
    } catch (error) {
      console.warn(
        "Groq insight generation failed, falling back to the built-in rule-based note:",
        (error as Error)?.message
      );
    }
  }

  return { text: buildFallbackInsight(input), source: "fallback" };
}
