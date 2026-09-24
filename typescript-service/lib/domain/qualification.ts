import { z } from "zod";

export const qualificationScore = z.object({ score: z.number().int().min(0).max(100), reason: z.string().trim().min(1).max(2000) }).strict();
export function qualificationDecision(value: unknown) {
  const { score, reason } = qualificationScore.parse(value);
  const status = score >= 70 ? "qualified" : score >= 40 ? "review_later" : "disqualified";
  return { score, rationale: reason, status,
    tag: status === "review_later" ? "review-later" : status,
    stage: status === "qualified" ? "Qualified" : status === "review_later" ? "Identified" : "Disqualified" } as const;
}

export function qualificationEligibility(input: { tags: string[]; stage: string; username: string | null }) {
  const tags = new Set(input.tags.map((tag) => tag.trim().toLowerCase()));
  if (["opted-out", "disqualified", "qualified", "review-later"].some((tag) => tags.has(tag)) ||
      [...tags].some((tag) => /^score:\d+$/.test(tag))) return false;
  return input.stage === "Identified" && Boolean(input.username);
}

