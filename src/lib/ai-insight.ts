const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

export interface AtRiskInsightRequest {
  studentName: string;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  attendanceRate: number | null;
  averageScorePercent: number | null;
  assignmentCompletionRate: number | null;
  reasons: string[];
}

export class AiInsightNotConfiguredError extends Error {
  constructor() {
    super("GROQ_API_KEY is not set.");
    this.name = "AiInsightNotConfiguredError";
  }
}

const SYSTEM_PROMPT = `You write short notes for teachers about a student's recent academic
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

export async function generateAtRiskInsight(
  input: AtRiskInsightRequest
): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new AiInsightNotConfiguredError();
  }

  const userPrompt = `Student: ${input.studentName}
Risk level: ${input.riskLevel}
Attendance rate: ${input.attendanceRate !== null ? `${input.attendanceRate}%` : "not enough data"}
Average exam score: ${input.averageScorePercent !== null ? `${input.averageScorePercent}%` : "not enough data"}
Assignment completion: ${input.assignmentCompletionRate !== null ? `${input.assignmentCompletionRate}%` : "not enough data"}
Factors flagged: ${input.reasons.join(" ")}`;

  const response = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
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