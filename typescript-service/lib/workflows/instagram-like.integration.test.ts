import { describe, expect, it } from "vitest";
import { start } from "workflow/api";
import { instagramLikeWorkflow } from "./instagram-like";

describe("Instagram like workflow", () => {
  it("executes durable start and reconciliation paths without dependencies when disabled", async () => {
    for (const mode of ["execute", "reconcile"] as const) {
      const run = await start(instagramLikeWorkflow, ["disabled-fixture", mode]);
      expect(await run.returnValue).toEqual({ state: "disabled" });
    }
  });
});

