import { describe, expect, it } from "vitest";
import { ApifyClient } from "@/lib/clients/apify";
import { ApifyInstagramLikeProvider } from "@/lib/providers/instagram-like";
import { getLikeCookies, getLikeTarget, likeEnvironmentAllowsWrites } from "@/lib/config/likes";
import { instagramPost } from "@/lib/likes/contracts";
import { fakeHttp, json } from "../helpers/fake-http";

const target = { accountId: "123", accountUsername: "fixture_account", contactId: "contact-1", targetUsername: "fixture_target",
  postUrl: "https://www.instagram.com/reel/Fixture123/" };
const cookies = [{ name: "sessionid", value: "123%3Asynthetic-session" }, { name: "csrftoken", value: "synthetic-csrf" }, { name: "ds_user_id", value: "123" }];

describe("like account and URL controls", () => {
  it("defaults off and requires explicit production/action/emergency settings", () => {
    expect(likeEnvironmentAllowsWrites({})).toBe(false);
    const env = { IG_LIKE_ENABLED: "true", OUTREACH_EMERGENCY_DISABLED: "false", VERCEL_ENV: "production" };
    expect(likeEnvironmentAllowsWrites(env)).toBe(true);
    expect(likeEnvironmentAllowsWrites({ ...env, VERCEL_ENV: "preview" })).toBe(false);
    expect(likeEnvironmentAllowsWrites({ ...env, OUTREACH_EMERGENCY_DISABLED: "true" })).toBe(false);
    expect(likeEnvironmentAllowsWrites({ ...env, IG_LIKE_ENABLED: "TRUE" })).toBe(false);
    expect(() => getLikeTarget({})).toThrow("Invalid like pilot configuration");
  });
  it("canonicalizes post aliases and rejects profiles, non-Instagram URLs and credentials", () => {
    expect(instagramPost("https://instagram.com/reels/Fixture123/?utm_source=test")).toEqual({ shortcode: "Fixture123", postUrl: target.postUrl });
    expect(instagramPost("https://www.instagram.com/p/Fixture123/").shortcode).toBe("Fixture123");
    for (const value of ["https://instagram.com/fixture", "http://instagram.com/p/abc/", "https://instagram.com.evil.test/p/abc/",
      "https://name:pass@instagram.com/p/abc/", "https://instagram.com:444/p/abc/", "https://instagram.com/p/abc/extra"]) {
      expect(() => instagramPost(value)).toThrow();
    }
  });
  it("accepts a single cookie array tied to the expected account", () => {
    expect(getLikeCookies("123", JSON.stringify(cookies))).toEqual(cookies);
    for (const value of [JSON.stringify([cookies]), JSON.stringify(cookies.slice(0, 2)), JSON.stringify([...cookies, cookies[0]]),
      JSON.stringify(cookies.map((cookie) => ({ ...cookie, domain: ".example.test" }))),
      JSON.stringify(cookies.map((cookie) => ({ ...cookie, expirationDate: 1 }))), "secret-non-json"]) {
      expect(() => getLikeCookies("123", value)).toThrow("instagram-like:invalid_input");
    }
    expect(() => getLikeCookies("456", JSON.stringify(cookies))).toThrow("invalid_input");
  });
});

describe("Apify like adapter", () => {
  it("sends exactly one target and keeps credentials out of the result", async () => {
    const fetch = fakeHttp(json({ data: { id: "run-1", status: "READY" } }));
    const provider = new ApifyInstagramLikeProvider(new ApifyClient("fixture-token", { fetch, authorizeWrite: async () => true }), () => cookies);
    expect(await provider.start(target)).toBe("run-1");
    expect(String(fetch.mock.calls[0][0])).toContain("/acts/dead00~instagram-like-bot/runs");
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ cookies, postUrls: [target.postUrl], maxLikesPerRun: 1, delayBetweenLikes: 30 });
  });
  it("does not start without write authorization or retry an ambiguous start", async () => {
    const fetch = fakeHttp(new Error("synthetic-session should not escape"));
    const disabled = new ApifyInstagramLikeProvider(new ApifyClient("fixture", { fetch }), () => cookies);
    await expect(disabled.start(target)).rejects.toThrow("disabled"); expect(fetch).not.toHaveBeenCalled();
    const enabled = new ApifyInstagramLikeProvider(new ApifyClient("fixture", { fetch, authorizeWrite: async () => true }), () => cookies);
    await expect(enabled.start(target)).rejects.toThrow("apify:unknown_outcome"); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    [[], "unknown"], [[{ url: target.postUrl, status: "success" }], "success"],
    [[{ url: target.postUrl, status: "already_liked" }], "unknown"],
    [[{ url: "https://www.instagram.com/p/Wrong/", status: "success" }], "unknown"],
    [[{ url: "https://evil.test/p/Fixture123/", status: "success" }], "unknown"],
    [[{ url: target.postUrl, status: "success" }, { url: target.postUrl, status: "success" }], "unknown"],
    [[{ url: target.postUrl, status: "auth_error" }], "auth_error"],
    [[{ url: target.postUrl, status: "blocked" }], "blocked"],
    [[{ url: target.postUrl, status: "rate_limited" }], "rate_limited"],
    [[{ url: target.postUrl, status: "failed" }], "failed"],
  ])("requires one matching terminal dataset row (%j)", async (rows, state) => {
    const fetch = fakeHttp(json({ data: { id: "run", status: "SUCCEEDED", defaultDatasetId: "dataset", usageTotalUsd: 0.008 } }), json(rows));
    const provider = new ApifyInstagramLikeProvider(new ApifyClient("fixture", { fetch }), () => { throw new Error("Observation must not read cookies"); });
    expect(await provider.observe("run", target)).toEqual({ state, costUsd: 0.008 });
    expect(String(fetch.mock.calls[1][0])).toContain("offset=0&limit=2");
  });
  it("does not mistake an actor failure or missing output for confirmed success", async () => {
    const fetch = fakeHttp(json({ data: { id: "run", status: "FAILED", defaultDatasetId: "dataset" } }),
      json([{ url: target.postUrl, status: "success" }]), json({ data: { id: "run", status: "SUCCEEDED" } }),
      json({ data: { id: "run", status: "RUNNING" } }));
    const provider = new ApifyInstagramLikeProvider(new ApifyClient("fixture", { fetch }), () => cookies);
    expect((await provider.observe("run", target)).state).toBe("unknown");
    expect((await provider.observe("run", target)).state).toBe("unknown");
    expect((await provider.observe("run", target)).state).toBe("running");
  });
});


