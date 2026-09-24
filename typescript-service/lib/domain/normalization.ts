import { z } from "zod";

const usernameSchema = z.string().regex(/^[a-z0-9_](?:[a-z0-9_.]{0,28}[a-z0-9_])?$/);
const reserved = new Set(["p", "reel", "reels", "stories", "explore", "accounts", "direct"]);
export function normalizeInstagramUsername(value: string): string | null {
  let name = value.trim();
  if (/^(?:https?:\/\/|(?:www\.)?instagram\.com\/)/i.test(name)) {
    try {
      const url = new URL(/^https?:\/\//i.test(name) ? name : `https://${name}`);
      if (!["instagram.com", "www.instagram.com"].includes(url.hostname.toLowerCase()) || url.username || url.password) return null;
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length !== 1) return null;
      name = parts[0];
    } catch { return null; }
  }
  name = name.replace(/^@/, "").toLowerCase();
  return usernameSchema.safeParse(name).success && !reserved.has(name) && !name.includes("..") ? name : null;
}

export const leadCandidateSchema = z.object({
  platform: z.literal("instagram"), username: z.string(), displayName: z.string(), bio: z.string(),
  followerCount: z.number().int().nonnegative().nullable(), postCount: z.number().int().nonnegative().nullable(),
  lastPostAt: z.iso.datetime({ offset: true }).nullable(), location: z.string().nullable(), source: z.string().min(1),
});
export function normalizeCandidate(value: unknown) {
  const data = leadCandidateSchema.parse(value);
  const username = normalizeInstagramUsername(data.username);
  if (!username) throw new Error("Invalid Instagram username");
  return { ...data, username, profileUrl: `https://www.instagram.com/${username}/` };
}
export type LeadCandidate = ReturnType<typeof normalizeCandidate>;

