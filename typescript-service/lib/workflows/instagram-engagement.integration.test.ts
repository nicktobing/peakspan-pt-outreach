import { describe, expect, it } from "vitest";
import { start } from "workflow/api";
import { instagramEngagementWorkflow } from "./instagram-engagement";

describe("Instagram engagement workflow", () => {
  it("returns disabled without database or provider access when all stages are off", async () => {
    const run = await start(instagramEngagementWorkflow, ["disabled-fixture", "execute"]);
    expect(await run.returnValue).toEqual({ state: "disabled" });
  });
});

