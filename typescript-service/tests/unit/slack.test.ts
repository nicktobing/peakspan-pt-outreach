import { createHmac } from "node:crypto";
import { verifySlackSignature } from "@/lib/auth/slack";
import { describe, expect, it } from "vitest";

describe("Slack request verification", () => {
  const body = "payload=%7B%22type%22%3A%22block_actions%22%7D";
  const signingSecret = "test-signing-secret";
  const timestamp = 1_800_000_000;
  const signature = `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;

  it("accepts a valid current request", () => {
    expect(
      verifySlackSignature({
        body,
        signature,
        timestamp: String(timestamp),
        signingSecret,
        nowSeconds: timestamp,
      }),
    ).toBe(true);
  });

  it("rejects stale and altered requests", () => {
    expect(
      verifySlackSignature({
        body,
        signature,
        timestamp: String(timestamp),
        signingSecret,
        nowSeconds: timestamp + 301,
      }),
    ).toBe(false);
    expect(
      verifySlackSignature({
        body: `${body}altered`,
        signature,
        timestamp: String(timestamp),
        signingSecret,
        nowSeconds: timestamp,
      }),
    ).toBe(false);
  });
});
