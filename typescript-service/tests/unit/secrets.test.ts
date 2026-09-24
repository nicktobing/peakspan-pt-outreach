import { requireBearerSecret, secretMatches } from "@/lib/auth/secrets";
import { describe, expect, it } from "vitest";

describe("secret authentication", () => {
  it("accepts only an exact secret", () => {
    expect(secretMatches("expected-value", "expected-value")).toBe(true);
    expect(secretMatches("wrong-value", "expected-value")).toBe(false);
    expect(secretMatches(null, "expected-value")).toBe(false);
  });

  it("rejects a missing bearer token", () => {
    const response = requireBearerSecret(new Request("https://example.test"), "secret");
    expect(response?.status).toBe(401);
  });

  it("accepts a valid bearer token", () => {
    const request = new Request("https://example.test", {
      headers: { authorization: "Bearer secret" },
    });
    expect(requireBearerSecret(request, "secret")).toBeUndefined();
  });
});
