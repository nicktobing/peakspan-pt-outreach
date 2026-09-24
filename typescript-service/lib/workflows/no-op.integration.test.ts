import { describe, expect, it } from "vitest";
import { start } from "workflow/api";
import { noOpWorkflow } from "./no-op";

describe("no-op workflow", () => {
  it("runs one durable step without outbound actions", async () => {
    const run = await start(noOpWorkflow, ["smoke-test"]);
    const result = await run.returnValue;

    expect(result.correlationId).toBe("smoke-test");
    expect(result.outboundActions).toBe(0);
    expect(result.executedAt).toEqual(expect.any(String));
  });
});
