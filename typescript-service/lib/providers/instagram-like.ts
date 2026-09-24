import { z } from "zod";
import { ApifyClient } from "../clients/apify";
import { ProviderError } from "../clients/errors";
import { LIKE_ACTOR } from "../config/likes";
import { actorLikeStatus, instagramPost, type LikeObservation, type LikeProvider, type LikeTarget } from "../likes/contracts";

export class ApifyInstagramLikeProvider implements LikeProvider {
  constructor(private readonly apify: ApifyClient, private readonly cookies: () => unknown) {}

  async start(target: LikeTarget) {
    const run = await this.apify.startActor(LIKE_ACTOR, {
      cookies: this.cookies(), postUrls: [target.postUrl], maxLikesPerRun: 1, delayBetweenLikes: 30,
    });
    return run.id;
  }

  async observe(runId: string, target: LikeTarget): Promise<LikeObservation> {
    const run = await this.apify.getRun(runId);
    if (run.id !== runId) throw new ProviderError("instagram-like", "invalid_response");
    const costUsd = run.usageTotalUsd;
    if (["READY", "RUNNING", "TIMING-OUT", "ABORTING"].includes(run.status)) return { state: "running", costUsd };
    if (!run.defaultDatasetId) return { state: "unknown", costUsd };
    const records = await this.apify.readDatasetHead(run.defaultDatasetId, z.unknown(), 2);
    // One exact target/result is required. Never infer action success from run status.
    const result = z.array(z.object({ url: z.string(), status: actorLikeStatus })).length(1).safeParse(records);
    if (!result.success) return { state: "unknown", costUsd };
    const row = result.data[0];
    try {
      if (instagramPost(row.url).shortcode !== instagramPost(target.postUrl).shortcode) return { state: "unknown", costUsd };
    } catch { return { state: "unknown", costUsd }; }
    if (["auth_error", "blocked", "rate_limited"].includes(row.status)) return { state: row.status as "auth_error" | "blocked" | "rate_limited", costUsd };
    if (run.status !== "SUCCEEDED") return { state: "unknown", costUsd };
    return { state: row.status === "success" ? "success" : "failed", costUsd };
  }
}

