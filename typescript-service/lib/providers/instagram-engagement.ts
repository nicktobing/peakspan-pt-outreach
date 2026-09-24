import { z } from "zod";
import { ApifyClient } from "../clients/apify";
import { ProviderError } from "../clients/errors";
import { COMMENT_ACTOR, DM_ACTOR, FOLLOW_ACTOR } from "../config/engagement";
import { instagramPost } from "../likes/contracts";
import type { EngagementObservation, EngagementProvider, EngagementTarget } from "../engagement/contracts";

export class ApifyInstagramEngagementProvider implements EngagementProvider {
  constructor(private readonly apify: ApifyClient, private readonly cookies: () => unknown,
    private readonly sessionId: () => string) {}

  async start(target: EngagementTarget) {
    if (target.action === "follow") return (await this.apify.startActor(FOLLOW_ACTOR, {
      sessionCookie: this.sessionId(), usersToFollow: [target.targetUsername], accountType: "mature",
      maxFollowsPerRun: 1, delayBetweenFollows: 45, randomDelayVariation: 5,
    })).id;
    if (target.action === "dm") return (await this.apify.startActor(DM_ACTOR, {
      sessionId: this.sessionId(), recipients: target.targetUsername, message: target.text,
      minDelay: 30, maxDelay: 45, dryRun: false,
    })).id;
    return (await this.apify.startActor(COMMENT_ACTOR, {
      postUrls: [{ url: target.postUrl }], commentMessage: target.text, cookies: this.cookies(),
      navigationTimeoutSecs: 45, slowdownMaxMs: 1800, typingDelayMaxMs: 140, maxRetries: 0,
    })).id;
  }

  async observe(runId: string, target: EngagementTarget): Promise<EngagementObservation> {
    const run = await this.apify.getRun(runId);
    if (run.id !== runId) throw new ProviderError("instagram-engagement", "invalid_response");
    const costUsd = run.usageTotalUsd;
    if (["READY", "RUNNING", "TIMING-OUT", "ABORTING"].includes(run.status)) return { state: "running", costUsd };
    if (!run.defaultDatasetId) return { state: "unknown", costUsd };
    const rows = await this.apify.readDatasetHead(run.defaultDatasetId, z.unknown(), 2);
    if (target.action === "follow") {
      if (run.status !== "SUCCEEDED") return { state: "unknown", costUsd };
      const report = await this.apify.readRunKeyValueRecord(runId, "RUN_REPORT", followReportSchema).catch(() => undefined);
      if (!report || report.summary.totalProcessed !== 1 || report.results.length !== 1) return { state: "unknown", costUsd };
      const result = report.results[0];
      if (result.username.toLowerCase().replace(/^@/, "") !== target.targetUsername) return { state: "unknown", costUsd };
      const dataset = z.array(followDatasetRowSchema).max(1).safeParse(rows);
      if (!dataset.success) return { state: "unknown", costUsd };
      const summary = report.summary;
      const classifiedCount = summary.successCount + summary.requestedCount + summary.alreadyFollowingCount + summary.failedCount;
      if (classifiedCount !== summary.totalProcessed) return { state: "unknown", costUsd };
      const remaining = summary.remainingUsers ?? summary.unprocessedUsers;
      if (remaining === undefined || (summary.remainingUsers !== undefined && summary.unprocessedUsers !== undefined &&
        summary.remainingUsers !== summary.unprocessedUsers)) return { state: "unknown", costUsd };
      const expectedRemaining = result.status === "failed" ? 1 : 0;
      if (remaining !== expectedRemaining) return { state: "unknown", costUsd };
      const zeroDelivered = summary.successCount === 0 && summary.requestedCount === 0 && dataset.data.length === 0;
      if (summary.rateLimited) return zeroDelivered && summary.alreadyFollowingCount === 0 && summary.failedCount === 1 &&
        result.status === "failed" && !result.success
        ? { state: "rate_limited", costUsd } : { state: "unknown", costUsd };
      if (result.status === "followed" && result.success && summary.successCount === 1 && summary.requestedCount === 0 &&
        summary.alreadyFollowingCount === 0 && summary.failedCount === 0 && dataset.data.length === 1 &&
        sameFollowDatasetResult(dataset.data[0], result, target.targetUsername)) return { state: "success", costUsd };
      if (result.status === "requested" && result.success && summary.successCount === 0 && summary.requestedCount === 1 &&
        summary.alreadyFollowingCount === 0 && summary.failedCount === 0 && dataset.data.length === 1 &&
        sameFollowDatasetResult(dataset.data[0], result, target.targetUsername)) return { state: "requested", costUsd };
      if (result.status === "already_following" && !result.success && zeroDelivered &&
        summary.alreadyFollowingCount === 1 && summary.failedCount === 0)
        return { state: "already_following", costUsd };
      if (result.status === "failed" && !result.success && zeroDelivered && summary.alreadyFollowingCount === 0 && summary.failedCount === 1)
        return { state: "failed", costUsd };
      return { state: "unknown", costUsd };
    }
    if (rows.length !== 1) return { state: "unknown", costUsd };
    if (target.action === "dm") {
      const parsed = z.object({ username: z.string(), status: z.enum(["success", "failed", "dry-run"]), message: z.string() }).safeParse(rows[0]);
      if (!parsed.success || parsed.data.username.toLowerCase().replace(/^@/, "") !== target.targetUsername || parsed.data.message !== target.text) return { state: "unknown", costUsd };
      if (run.status !== "SUCCEEDED") return { state: "unknown", costUsd };
      return { state: parsed.data.status === "success" ? "success" : parsed.data.status === "failed" ? "failed" : "unknown", costUsd };
    }
    const parsed = z.object({ status: z.enum(["success", "failed"]), success: z.boolean(), postUrl: z.string(), commentMessage: z.string(),
      resolvedCommentMessage: z.string(), commentSubmitted: z.boolean() }).safeParse(rows[0]);
    if (!parsed.success) return { state: "unknown", costUsd };
    let samePost = false;
    try { samePost = instagramPost(parsed.data.postUrl).shortcode === instagramPost(target.postUrl).shortcode; } catch { /* invalid provider URL */ }
    if (!samePost || parsed.data.commentMessage !== target.text || parsed.data.resolvedCommentMessage !== target.text) return { state: "unknown", costUsd };
    if (run.status !== "SUCCEEDED") return { state: "unknown", costUsd };
    if (parsed.data.status === "success" && parsed.data.success && parsed.data.commentSubmitted) return { state: "success", costUsd };
    if (parsed.data.status === "failed" && !parsed.data.success && !parsed.data.commentSubmitted) return { state: "failed", costUsd };
    return { state: "unknown", costUsd };
  }
}

const followDatasetRowSchema = z.object({ username: z.string(), status: z.enum(["followed", "requested"]), success: z.literal(true) });
const followReportSchema = z.object({
  summary: z.object({ totalProcessed: z.number().int().nonnegative(), successCount: z.number().int().nonnegative(),
    requestedCount: z.number().int().nonnegative(), alreadyFollowingCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(), rateLimited: z.boolean(),
    remainingUsers: z.number().int().nonnegative().optional(), unprocessedUsers: z.number().int().nonnegative().optional() }),
  results: z.array(z.object({ username: z.string(), status: z.enum(["followed", "requested", "already_following", "failed"]),
    success: z.boolean(), reason: z.string().optional() })).max(2),
});
function sameFollowDatasetResult(dataset: z.infer<typeof followDatasetRowSchema>, report: z.infer<typeof followReportSchema>["results"][number],
  username: string) {
  return dataset.username.toLowerCase().replace(/^@/, "") === username && dataset.status === report.status && dataset.success === report.success;
}
