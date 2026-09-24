import { describe, expect, it } from "vitest";
import { batchConfigSchema, batchEligible, contactUsername, selectPost } from "@/lib/likes/batch-contracts";
const now = new Date("2026-09-16T00:00:00Z");
const post = (code: string, owner: string, timestamp = "2026-09-15T00:00:00Z") => ({ url: `https://instagram.com/reel/${code}/`, ownerUsername: owner, timestamp });
describe("batch campaign contracts", () => {
  it("caps profiles and attempted actions independently below 30", () => {
    expect(batchConfigSchema.parse({})).toMatchObject({ IG_SESSION_PROFILE_LIMIT: 10, IG_SESSION_ACTION_LIMIT: 10, IG_ROLLING_DAY_ACTION_LIMIT: 29 });
    for (const name of ["IG_SESSION_PROFILE_LIMIT", "IG_SESSION_ACTION_LIMIT", "IG_ROLLING_DAY_ACTION_LIMIT"]) {
      expect(batchConfigSchema.safeParse({ [name]: 30 }).success).toBe(false);
    }
    expect(batchConfigSchema.safeParse({ IG_ACTION_DELAY_SECONDS: 0 }).success).toBe(false);
  });
  it("preserves followed/qualified eligibility and response suppression", () => {
    const contact = { id: "contact", customFields: [], tags: ["qualified", "ig-followed"] };
    expect(batchEligible(contact)).toBe(true);
    expect(batchEligible({ ...contact, tags: ["qualified"] })).toBe(false);
    for (const tag of ["ig-liked", "responded", "ig-responded", "opted-out", "disqualified", "cold", "escalated"]) {
      expect(batchEligible({ ...contact, tags: [...contact.tags, tag] })).toBe(false);
    }
    expect(batchEligible(contact, true)).toBe(false);
  });
  it("uses the configured profile field, never a display name or unrelated website", () => {
    const contact = { id: "contact", tags: [], customFields: [{ id: "profile", value: "https://instagram.com/Trainer/" }] };
    expect(contactUsername(contact, "profile")).toBe("trainer");
    expect(contactUsername(contact, "wrong")).toBeNull();
    expect(contactUsername({ ...contact, customFields: [{ id: "profile", value: "https://other.test/trainer" }] }, "profile")).toBeNull();
  });
  it("prefers recent owned posts, verifies coauthors for fallback, and ignores pinned-order and duplicate artifacts", () => {
    const collab = { ...post("Collab", "someone_else"), coauthorProducers: [{ username: "trainer" }] };
    const owned = post("Owned", "trainer", "2026-09-14T00:00:00Z");
    expect(selectPost([collab, owned], "trainer", now)?.url).toContain("Owned");
    expect(selectPost([collab], "trainer", now)?.url).toContain("Collab");
    expect(selectPost([post("Other", "other")], "trainer", now)).toBeNull();
    expect(selectPost([post("Old", "trainer", "2025-01-01T00:00:00Z")], "trainer", now)).toBeNull();
    expect(selectPost([post("Future", "trainer", "2027-01-01T00:00:00Z")], "trainer", now)).toBeNull();
    expect(selectPost([owned], "trainer", now, new Set(["https://www.instagram.com/reel/Owned/"]))).toBeNull();
    expect(selectPost([{ malformed: true }, owned], "trainer", now)?.url).toContain("Owned");
  });
});

