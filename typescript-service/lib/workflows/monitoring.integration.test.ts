import { describe, expect, it } from "vitest";
import { start } from "workflow/api";
import { monitoringWorkflow } from "./monitoring";

describe("monitoring workflow", () => {
  it("runs a durable step with live operation disabled and no provider configuration", async () => {
    // Integration process uses a test-only disabled environment, never host env.
    const run = await start(monitoringWorkflow, ["disabled-fixture-run"]);
    expect(await run.returnValue).toEqual({ disabled: true });
  });
});

