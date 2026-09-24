import { describe, expect, it } from "vitest";
import { normalizeInstagramUsername } from "@/lib/domain/normalization";
import { qualificationDecision, qualificationEligibility } from "@/lib/domain/qualification";
import { actionEligible, followupDue } from "@/lib/domain/eligibility";
import { checkMessage } from "@/lib/domain/compliance";
import { contactTransition, reconcileTags } from "@/lib/domain/contact-state";
import { idempotencyKey } from "@/lib/domain/idempotency";
import { DmDisabledProvider } from "@/lib/providers/dm-disabled";

describe("normalization and qualification", () => {
  it("canonicalizes handles and URLs without accepting other hosts or posts", () => {
    expect(normalizeInstagramUsername(" @Coach_PT ")).toBe("coach_pt");
    expect(normalizeInstagramUsername("https://www.instagram.com/Coach_PT/?ref=fixture")).toBe("coach_pt");
    for (const invalid of ["https://evil.test/coach", "https://instagram.com/p/abc", "https://instagram.com@evil.test/coach", "bad name", "a..b"])
      expect(normalizeInstagramUsername(invalid)).toBeNull();
  });
  it.each([[39, "disqualified", "Disqualified"], [40, "review_later", "Identified"], [69, "review_later", "Identified"], [70, "qualified", "Qualified"]])
    ("routes boundary %i", (score, status, stage) => expect(qualificationDecision({ score, reason: "Fixture" })).toMatchObject({ status, stage }));
  it("skips already-scored contacts without confusing qualified and disqualified tags", () => {
    expect(qualificationEligibility({ stage: "Identified", username: "coach", tags: ["score:69"] })).toBe(false);
    expect(actionEligible({ tags: ["disqualified"], suppressed: false }, "follow")).toBe(false);
    expect(actionEligible({ tags: ["qualified", "customer"], suppressed: false }, "follow")).toBe(true);
  });
});
describe("campaign safety and state", () => {
  it("requires prerequisites and blocks completed, replied, and opted-out contacts", () => {
    expect(actionEligible({ tags: ["ig-comment-3"], suppressed: false }, "dm")).toBe(true);
    for (const tag of ["ig-dm-sent", "responded", "opted-out", "escalated"])
      expect(actionEligible({ tags: ["ig-comment-3", tag], suppressed: false }, "dm")).toBe(false);
    expect(actionEligible({ tags: ["ig-comment-3"], suppressed: true }, "dm")).toBe(false);
    expect(actionEligible({ tags: [], suppressed: false }, "comment_2")).toBe(false);
  });
  it("uses day 3/7/14 follow-ups and moves to Cold only after all three", () => {
    const contact = { tags: ["outreach-sent"], suppressed: false, outreachDate: "2026-09-01T00:00:00Z" };
    expect(followupDue({ ...contact, followupCount: 0 }, new Date("2026-09-03T23:59:59Z"))).toBeNull();
    expect(followupDue({ ...contact, followupCount: 0 }, new Date("2026-09-04T00:00:00Z"))).toMatchObject({ number: 1 });
    expect(followupDue({ ...contact, followupCount: 1 }, new Date("2026-09-08T00:00:00Z"))).toMatchObject({ number: 2 });
    expect(followupDue({ ...contact, followupCount: 2 }, new Date("2026-09-15T00:00:00Z"))).toMatchObject({ number: 3, maxWords: 80 });
    expect(followupDue({ ...contact, followupCount: 3 }, new Date("2026-09-16T00:00:00Z"))).toEqual({ action: "move_to_cold" });
    expect(followupDue({ ...contact, tags: ["responded"] }, new Date("2026-09-16T00:00:00Z"))).toBeNull();
  });
  it("rejects empty messages, blocked wording, links and overlong text", () => {
    expect(checkMessage("Hello coach, would you be open to a conversation?").compliant).toBe(true);
    for (const text of ["", "Guaranteed results", "Visit HTTPS://example.test", Array(101).fill("word").join(" ")])
      expect(checkMessage(text).compliant).toBe(false);
  });
  it("preserves unrelated tags and suppresses pending sends on reply or opt-out", () => {
    const transition = contactTransition("opt_out");
    expect(transition.suppress).toBe(true);
    expect(reconcileTags(["customer", "outreach-sent"], transition.add, transition.remove)).toEqual(["customer", "opted-out"]);
    expect(contactTransition("response_detected").suppress).toBe(true);
  });
  it("avoids separator collisions in deterministic idempotency keys", () => {
    expect(idempotencyKey("follow", "a:b", "c")).not.toBe(idempotencyKey("follow", "a", "b:c"));
    expect(idempotencyKey("follow", "contact", "v1")).toBe(idempotencyKey("follow", "contact", "v1"));
    expect(idempotencyKey("follow", "contact", "v1")).not.toBe(idempotencyKey("follow", "contact", "v2"));
  });
  it("provides a disabled DM implementation with no network access", async () => {
    const provider = new DmDisabledProvider();
    expect(await provider.validateCredentials()).toEqual({ healthy: false, reason: "disabled" });
    await expect(provider.send()).rejects.toThrow("disabled");
    await expect(provider.getStatus()).rejects.toThrow("disabled");
  });
});

