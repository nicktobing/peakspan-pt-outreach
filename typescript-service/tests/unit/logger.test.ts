import { log, sanitizeLogContext } from "@/lib/observability/logger";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.restoreAllMocks());

describe("log redaction", () => {
  it("keeps diagnostic identifiers and counts while omitting payloads and credentials", () => {
    expect(sanitizeLogContext({
      workflowRunId: "run-123", status: "failed", count: 3,
      authorization: "Bearer synthetic-token",
      nested: { apiToken: "synthetic-token", status: "failed" },
      payload: { email: "person@example.test", message_text: "private message" },
      databaseUrl: "postgresql://user:synthetic-password@localhost/db",
      error: "Request failed with Bearer synthetic-token",
    })).toEqual({ workflowRunId: "run-123", status: "failed", count: 3 });
  });

  it("rejects credential-bearing strings in diagnostic fields", () => {
    expect(sanitizeLogContext({
      errorCode: "Bearer synthetic-token",
      providerExternalId: "https://user:synthetic-password@example.test",
    })).toEqual({ errorCode: "[REDACTED]", providerExternalId: "[REDACTED]" });
  });

  it("does not log arbitrary event text or allow context to overwrite log metadata", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    // Exercise untyped runtime callers as well as the TypeScript contract.
    // @ts-expect-error Free-form diagnostic messages are forbidden.
    log("error", "Request failed with Bearer synthetic-token", {
      event: "private message", level: "secret", timestamp: "secret", status: "failed",
    });
    const entry = JSON.parse(output.mock.calls[0][0]);
    expect(entry).toEqual({
      level: "error", event: "[REDACTED]", status: "failed", timestamp: expect.any(String),
    });
    expect(output.mock.calls[0][0]).not.toContain("synthetic-token");
  });
});

