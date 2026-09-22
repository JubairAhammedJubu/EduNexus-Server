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

function formatMetric(value: number | null): string {
  return value !== null ? `${value}%` : "not enough data";
}

/** Growth areas named from the numbers only — never a risk label. */
function describeGrowthFocus(input: PerformanceInsightRequest): string {
  const areas: string[] = [];
  if (input.attendanceRate !== null && input.attendanceRate < 85) {
    areas.push("showing up consistently");
  }
  if (input.averageScorePercent !== null && input.averageScorePercent < 65) {
    areas.push("exam practice");
  }
  if (input.assignmentCompletionRate !== null && input.assignmentCompletionRate < 75) {
    areas.push("turning assignments in");
  }
  if (areas.length === 0) {
    return "The recent pattern looks steady. Encourage them to keep the habit going.";
  }
  return `A useful focus this week: ${areas.join(" and ")}.`;
}

function buildTeacherUserPrompt(input: PerformanceInsightRequest): string {
  return `Student: ${input.studentName}
Risk level (for the teacher only — do not treat it as a diagnosis): ${input.riskLevel}
Attendance rate: ${formatMetric(input.attendanceRate)}
Average exam score: ${formatMetric(input.averageScorePercent)}
Assignment completion: ${formatMetric(input.assignmentCompletionRate)}
Factors flagged: ${input.reasons.join(" ")}`;
}

function buildStudentUserPrompt(input: PerformanceInsightRequest): string {
  return `Student: ${input.studentName}
Attendance rate: ${formatMetric(input.attendanceRate)}
Average exam score: ${formatMetric(input.averageScorePercent)}
Assignment completion: ${formatMetric(input.assignmentCompletionRate)}
${describeGrowthFocus(input)}

Write the note directly to the student. Stay encouraging.
Do not use the words risk, at-risk, failing, failure, warning, or concern.`;
}

const STUDENT_BANNED_LANGUAGE =
  /\b(at[-\s]?risk|high risk|medium risk|low risk|failing|failure|warning|concerning|concern)\b/i;

async function callGroqChat(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number
): Promise<string> {
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
        { role: "user", content: userPrompt },
      ],
      temperature: 0.4,
      max_tokens: maxTokens,
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
      ? "You've got a clear place to grow, and a little focused effort this week can move these numbers."
      : `A few things in ${input.studentName}'s recent numbers are worth checking in on.`;
    suggestion = isStudent
      ? "A good next step is picking just one area and giving it extra time this week. A short chat with a teacher can help you choose where to start."
      : "A brief, low-pressure check-in conversation could help surface what's getting in the way.";
  } else if (input.riskLevel === "MEDIUM") {
    openLine = isStudent
      ? "You're in a good spot overall, and a bit more consistency will strengthen a couple of areas."
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

  // Teacher-facing reasons name thresholds ("below passing"). Those
  // phrases stay on the teacher view only.
  const reasonsSentence =
    !isStudent && input.reasons.length > 0 && input.riskLevel !== "LOW"
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

  const fallback = () => ({ text: buildFallbackInsight(input), source: "fallback" as const });

  if (apiKey) {
    try {
      const systemPrompt =
        input.perspective === "student" ? buildStudentSystemPrompt() : buildTeacherSystemPrompt();
      const userPrompt =
        input.perspective === "student"
          ? buildStudentUserPrompt(input)
          : buildTeacherUserPrompt(input);
      const text = await callGroqChat(apiKey, systemPrompt, userPrompt, 220);

      if (input.perspective === "student" && STUDENT_BANNED_LANGUAGE.test(text)) {
        console.warn("Student insight contained concern language; using the encouraging template.");
        return fallback();
      }

      return { text, source: "groq" };
    } catch (error) {
      console.warn(
        "Groq insight generation failed, falling back to the built-in rule-based note:",
        (error as Error)?.message
      );
    }
  }

  return fallback();
}

export interface FeedbackDraftRequest {
  studentName: string;
  assignmentTitle: string;
  subject: string;
  assignmentDescription: string | null;
  /** Score the teacher already entered. The model must not change it. */
  marks: number;
  totalMarks: number;
}

function buildFeedbackSystemPrompt(): string {
  return `You draft a short feedback comment a teacher will review before it
is sent to a student. The score is already decided by the teacher. You
only write the comment.

Rules:
- 2-4 sentences, second person ("you"/"your"), plain and supportive.
- Repeat the score exactly as given. Never suggest a different score,
  grade, or mark.
- You have not read the student's file. Do not invent specific mistakes,
  quotes, or strengths that are not in the assignment title or description.
- If the description is thin, stay general and point to one low-stakes
  next step.
- Do not mention that you are an AI.`;
}

function buildFeedbackUserPrompt(input: FeedbackDraftRequest): string {
  const description = input.assignmentDescription?.trim() || "No description was provided.";
  return `Student: ${input.studentName}
Assignment: ${input.assignmentTitle}
Subject: ${input.subject}
Assignment description: ${description}
Teacher-entered score: ${input.marks} out of ${input.totalMarks}

Draft the comment. The score stays ${input.marks}/${input.totalMarks}.`;
}

function buildFeedbackFallback(input: FeedbackDraftRequest): string {
  const percent =
    input.totalMarks > 0 ? Math.round((input.marks / input.totalMarks) * 100) : 0;
  const scoreLine = `You scored ${input.marks} out of ${input.totalMarks} on ${input.assignmentTitle}.`;

  if (percent >= 85) {
    return `${scoreLine} This is strong work in ${input.subject}. Keep the approach that worked here, and use one idea from the task on the next assignment.`;
  }
  if (percent >= 60) {
    return `${scoreLine} This is a solid submission in ${input.subject}. A useful next step is to revisit the part of the task that felt least certain before the next one.`;
  }
  return `${scoreLine} Thanks for turning it in. A good next step is to go over the task with your teacher and redo one section so the next submission is clearer.`;
}

/**
 * Drafts assignment feedback from the assignment context and a score
 * the teacher already entered. Does not persist anything — the caller
 * must keep the teacher as the last step before a student sees it.
 */
export async function generateFeedbackDraft(
  input: FeedbackDraftRequest
): Promise<GeneratedInsight> {
  const apiKey = process.env.GROQ_API_KEY;
  const fallback = () => ({ text: buildFeedbackFallback(input), source: "fallback" as const });

  if (apiKey) {
    try {
      const text = await callGroqChat(
        apiKey,
        buildFeedbackSystemPrompt(),
        buildFeedbackUserPrompt(input),
        180
      );
      return { text, source: "groq" };
    } catch (error) {
      console.warn(
        "Groq feedback draft failed, falling back to the built-in template:",
        (error as Error)?.message
      );
    }
  }

  return fallback();
}

export type NoticeCategory = "Academic" | "Events" | "General";

export interface NoticeDraftRequest {
  notes: string;
  category: NoticeCategory;
}

export interface NoticeDraft {
  title: string;
  detail: string;
  source: "groq" | "fallback";
}

function buildNoticeSystemPrompt(): string {
  return `You turn a teacher's rough notes into a short school notice.
You do not publish it. A person will review and edit your draft first.

Rules:
- Use only facts that appear in the notes. Do not invent dates, times,
  rooms, requirements, or consequences.
- Title: under 80 characters, specific, no clickbait.
- Detail: 2-5 sentences, plain language, suitable to post on a school
  notice board.
- Reply with JSON only, no markdown: {"title":"...","detail":"..."}`;
}

function parseNoticeJson(raw: string): { title: string; detail: string } | null {
  const cleaned = raw.replace(/```json|```/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as {
      title?: unknown;
      detail?: unknown;
    };
    if (typeof parsed.title !== "string" || typeof parsed.detail !== "string") return null;
    const title = parsed.title.trim().slice(0, 120);
    const detail = parsed.detail.trim().slice(0, 2000);
    if (!title || !detail) return null;
    return { title, detail };
  } catch {
    return null;
  }
}

function buildNoticeFallback(input: NoticeDraftRequest): { title: string; detail: string } {
  const cleaned = input.notes.replace(/\s+/g, " ").trim();
  const sentence = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  const detail = /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
  const firstClause = sentence.split(/[.,;]/)[0]?.trim() ?? "";
  const title =
    firstClause.length >= 8 && firstClause.length <= 80
      ? firstClause
      : `${input.category} notice`;
  return { title, detail };
}

/**
 * Turns rough notice notes into a title and body. Does not create a
 * notice — publishing stays a separate, human action.
 */
export async function generateNoticeDraft(input: NoticeDraftRequest): Promise<NoticeDraft> {
  const apiKey = process.env.GROQ_API_KEY;
  const fallback = () => ({ ...buildNoticeFallback(input), source: "fallback" as const });

  if (apiKey) {
    try {
      const raw = await callGroqChat(
        apiKey,
        buildNoticeSystemPrompt(),
        `Category: ${input.category}\nRough notes: ${input.notes.trim()}`,
        400
      );
      const parsed = parseNoticeJson(raw);
      if (!parsed) {
        console.warn("Groq notice draft was not valid JSON; using the built-in wording.");
        return fallback();
      }
      return { ...parsed, source: "groq" };
    } catch (error) {
      console.warn(
        "Groq notice draft failed, falling back to the built-in wording:",
        (error as Error)?.message
      );
    }
  }

  return fallback();
}
