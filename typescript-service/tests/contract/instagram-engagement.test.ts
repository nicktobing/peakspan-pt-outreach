import { describe, expect, it } from "vitest";
import { ApifyClient } from "@/lib/clients/apify";
import { engagementEnvironmentAllowsWrites } from "@/lib/config/engagement";
import { commentTargetSchema, dmTargetSchema, engagementTargetSchema } from "@/lib/engagement/contracts";
import { ApifyInstagramEngagementProvider } from "@/lib/providers/instagram-engagement";
import { fakeHttp, json } from "../helpers/fake-http";

const base = { accountId: "123", accountUsername: "acting_account", contactId: "contact-1", targetUsername: "target_account" };
const cookies = [{ name: "sessionid", value: "123%3Asession" }, { name: "csrftoken", value: "csrf" }, { name: "ds_user_id", value: "123" }];
const provider = (fetch: ReturnType<typeof fakeHttp>) => new ApifyInstagramEngagementProvider(new ApifyClient("fixture", { fetch, authorizeWrite: async () => true }), () => cookies, () => "123%3Asession");

describe("engagement gates and input", () => {
  it("keeps each stage independently disabled and adds a second DM provider gate", () => {
    const common = { OUTREACH_EMERGENCY_DISABLED: "false", VERCEL_ENV: "production" };
    expect(engagementEnvironmentAllowsWrites("follow", { ...common, IG_FOLLOW_ENABLED: "true" })).toBe(true);
    expect(engagementEnvironmentAllowsWrites("comment_1", { ...common, IG_COMMENT_ENABLED: "true" })).toBe(true);
    expect(engagementEnvironmentAllowsWrites("dm", { ...common, IG_DM_ENABLED: "true" })).toBe(false);
    expect(engagementEnvironmentAllowsWrites("dm", { ...common, IG_DM_ENABLED: "true", IG_DM_PROVIDER_VALIDATED: "true" })).toBe(true);
    expect(engagementEnvironmentAllowsWrites("follow", { ...common, IG_FOLLOW_ENABLED: "false" })).toBe(false);
  });
  it("rejects unsafe comments and DMs before any provider call", () => {
    expect(engagementTargetSchema.safeParse({ ...base, action: "comment_1", postUrl: "https://instagram.com/reel/Fixture/", text: "{Nice|Great}" }).success).toBe(false);
    expect(engagementTargetSchema.safeParse({ ...base, action: "dm", approvalBatchId: crypto.randomUUID(), text: "Hello there" }).success).toBe(false);
    expect(engagementTargetSchema.safeParse({ ...base, action: "dm", approvalBatchId: crypto.randomUUID(), text: "Hi, PeakSpan has an affiliate referral opportunity." }).success).toBe(true);
  });
});

describe("Apify engagement evidence", () => {
  it("sends one follow and requires one matching delivered result", async () => {
    const target = engagementTargetSchema.parse({ ...base, action: "follow" });
    const startFetch = fakeHttp(json({ data: { id: "follow-run", status: "READY" } }));
    expect(await provider(startFetch).start(target)).toBe("follow-run");
    expect(JSON.parse(startFetch.mock.calls[0][1]!.body as string)).toMatchObject({ usersToFollow: [base.targetUsername],
      accountType: "mature", maxFollowsPerRun: 1 });
    const report = (status: "followed" | "requested" | "already_following" | "failed", success: boolean, rateLimited = false) => ({
      summary: { totalProcessed: 1, successCount: status === "followed" ? 1 : 0, requestedCount: status === "requested" ? 1 : 0,
        alreadyFollowingCount: status === "already_following" ? 1 : 0, failedCount: status === "failed" ? 1 : 0, rateLimited,
        remainingUsers: status === "failed" ? 1 : 0 },
      results: [{ username: base.targetUsername, status, success, reason: "fixture" }],
    });
    const good = provider(fakeHttp(json({ data: { id: "run", status: "SUCCEEDED", defaultDatasetId: "data" } }),
      json([{ username: base.targetUsername, status: "followed", success: true }]), json(report("followed", true))));
    expect((await good.observe("run", target)).state).toBe("success");
    const requested = provider(fakeHttp(json({ data: { id: "run", status: "SUCCEEDED", defaultDatasetId: "data" } }),
      json([{ username: base.targetUsername, status: "requested", success: true }]), json(report("requested", true))));
    expect((await requested.observe("run", target)).state).toBe("requested");
    const already = provider(fakeHttp(json({ data: { id: "run", status: "SUCCEEDED", defaultDatasetId: "data" } }),
      json([]), json(report("already_following", false))));
    expect((await already.observe("run", target)).state).toBe("already_following");
    const contradictoryAlready = provider(fakeHttp(json({ data: { id: "run", status: "SUCCEEDED", defaultDatasetId: "data" } }),
      json([]), json(report("already_following", true))));
    expect((await contradictoryAlready.observe("run", target)).state).toBe("unknown");
    const failed = provider(fakeHttp(json({ data: { id: "run", status: "SUCCEEDED", defaultDatasetId: "data" } }),
      json([]), json(report("failed", false))));
    expect((await failed.observe("run", target)).state).toBe("failed");
    const rateLimited = provider(fakeHttp(json({ data: { id: "run", status: "SUCCEEDED", defaultDatasetId: "data" } }),
      json([]), json(report("failed", false, true))));
    expect((await rateLimited.observe("run", target)).state).toBe("rate_limited");
    const contradictoryRateLimit = provider(fakeHttp(json({ data: { id: "run", status: "SUCCEEDED", defaultDatasetId: "data" } }),
      json([]), json({ ...report("failed", false, true), summary: {
        ...report("failed", false, true).summary, alreadyFollowingCount: 1,
      } })));
    expect((await contradictoryRateLimit.observe("run", target)).state).toBe("unknown");
    const remainingFollow = provider(fakeHttp(json({ data: { id: "run", status: "SUCCEEDED", defaultDatasetId: "data" } }),
      json([{ username: base.targetUsername, status: "followed", success: true }]), json({
        ...report("followed", true), summary: { ...report("followed", true).summary, remainingUsers: 1 },
      })));
    expect((await remainingFollow.observe("run", target)).state).toBe("unknown");
    const missingRemaining = provider(fakeHttp(json({ data: { id: "run", status: "SUCCEEDED", defaultDatasetId: "data" } }),
      json([{ username: base.targetUsername, status: "followed", success: true }]), json({
        ...report("followed", true), summary: { totalProcessed: 1, successCount: 1, requestedCount: 0,
          alreadyFollowingCount: 0, failedCount: 0, rateLimited: false },
      })));
    expect((await missingRemaining.observe("run", target)).state).toBe("unknown");
    const legacyFailedReport = report("failed", false);
    const legacyFailed = provider(fakeHttp(json({ data: { id: "run", status: "SUCCEEDED", defaultDatasetId: "data" } }),
      json([]), json({ ...legacyFailedReport, summary: {
        ...legacyFailedReport.summary, remainingUsers: undefined, unprocessedUsers: 1,
      } })));
    expect((await legacyFailed.observe("run", target)).state).toBe("failed");
    const empty = provider(fakeHttp(json({ data: { id: "run", status: "SUCCEEDED", defaultDatasetId: "data" } }), json([]),
      json({ ...report("failed", false), summary: { ...report("failed", false).summary, failedCount: 0 } })));
    expect((await empty.observe("run", target)).state).toBe("unknown");
  });
  it("requires the exact comment post and submitted text", async () => {
    const target = commentTargetSchema.parse({ ...base, action: "comment_1", postUrl: "https://instagram.com/reel/Fixture/", text: "Strong session, coach!" });
    const row = { status: "success", success: true, postUrl: target.postUrl, commentMessage: target.text,
      resolvedCommentMessage: target.text, commentSubmitted: true };
    const good = provider(fakeHttp(json({ data: { id: "run", status: "SUCCEEDED", defaultDatasetId: "data" } }), json([row])));
    expect((await good.observe("run", target)).state).toBe("success");
    const mismatch = provider(fakeHttp(json({ data: { id: "run", status: "SUCCEEDED", defaultDatasetId: "data" } }), json([{ ...row, resolvedCommentMessage: "Different" }])));
    expect((await mismatch.observe("run", target)).state).toBe("unknown");
    for (const conflicting of [{ ...row, status: "failed" }, { ...row, status: "dry-run" },
      { ...row, status: "success", success: false, commentSubmitted: false }]) {
      const result = provider(fakeHttp(json({ data: { id: "run", status: "SUCCEEDED", defaultDatasetId: "data" } }), json([conflicting])));
      expect((await result.observe("run", target)).state).toBe("unknown");
    }
    const failed = provider(fakeHttp(json({ data: { id: "run", status: "SUCCEEDED", defaultDatasetId: "data" } }),
      json([{ ...row, status: "failed", success: false, commentSubmitted: false }])));
    expect((await failed.observe("run", target)).state).toBe("failed");
  });
  it("requires the exact DM recipient, message, and success status", async () => {
    const target = dmTargetSchema.parse({ ...base, action: "dm", approvalBatchId: crypto.randomUUID(), text: "Hi, PeakSpan has an affiliate referral opportunity." });
    const good = provider(fakeHttp(json({ data: { id: "run", status: "SUCCEEDED", defaultDatasetId: "data" } }),
      json([{ username: base.targetUsername, status: "success", message: target.text }])));
    expect((await good.observe("run", target)).state).toBe("success");
    const dry = provider(fakeHttp(json({ data: { id: "run", status: "SUCCEEDED", defaultDatasetId: "data" } }),
      json([{ username: base.targetUsername, status: "dry-run", message: target.text }])));
    expect((await dry.observe("run", target)).state).toBe("unknown");
  });
});
