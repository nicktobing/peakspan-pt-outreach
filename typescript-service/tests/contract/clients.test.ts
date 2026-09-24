import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { JsonClient } from "@/lib/clients/http";
import { GhlClient } from "@/lib/clients/ghl";
import { ApifyClient } from "@/lib/clients/apify";
import { SlackClient } from "@/lib/clients/slack";
import { OpenAiClient } from "@/lib/clients/openai";
import { allowFixtureWrite, fakeHttp, json } from "../helpers/fake-http";

describe("HTTP failure policy", () => {
  it("retries safe reads on 429/503 and respects Retry-After", async () => {
    const fetch = fakeHttp(json({}, 429, { "retry-after": "2" }), json({}, 503), json({ ok: true }));
    const sleep = vi.fn(async () => {});
    const client = new JsonClient("test", "https://example.test", {}, { fetch, sleep });
    await expect(client.request("/read", z.object({ ok: z.boolean() }))).resolves.toEqual({ ok: true });
    expect(sleep.mock.calls).toEqual([[2000], [500]]);
  });
  it.each([400, 401, 403, 404, 422])("does not retry permanent HTTP %i", async (status) => {
    const fetch = fakeHttp(json({ token: "synthetic-private-data" }, status));
    const client = new JsonClient("test", "https://example.test", {}, { fetch });
    await expect(client.request("/read", z.object({}))).rejects.toThrow(`:${status}`);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("blocks writes by default and never retries uncertain non-idempotent writes", async () => {
    const fetch = fakeHttp(new Error("Bearer synthetic-secret"));
    const locked = new JsonClient("test", "https://example.test", {}, { fetch });
    await expect(locked.request("/send", z.object({}), { method: "POST" })).rejects.toThrow("disabled");
    expect(fetch).not.toHaveBeenCalled();
    const enabled = new JsonClient("test", "https://example.test", {}, { fetch, authorizeWrite: allowFixtureWrite });
    await expect(enabled.request("/send", z.object({}), { method: "POST" })).rejects.toThrow("test:unknown_outcome");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rechecks authorization before retrying a rate-limited mutation", async () => {
    const fetch = fakeHttp(json({}, 429));
    const authorizeWrite = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const client = new JsonClient("test", "https://example.test", {}, { fetch, authorizeWrite, sleep: async () => {} });
    await expect(client.request("/send", z.object({}), { method: "POST" })).rejects.toThrow("disabled");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("GHL contracts", () => {
  it("reads beyond 100 contacts without sending a write", async () => {
    const fetch = fakeHttp(json({ contacts: Array.from({ length: 100 }, (_, i) => ({ id: `contact-${i}`, tags: [] })), total: 101 }),
      json({ contacts: [{ id: "contact-100", tags: ["customer"] }], total: 101 }));
    const contacts = await new GhlClient("fixture", "location", { fetch }).listContacts();
    expect(contacts).toHaveLength(101);
    expect(JSON.parse(fetch.mock.calls[1][1]!.body as string)).toMatchObject({ page: 2, pageLimit: 100, locationId: "location" });
  });
  it("fails rather than returning a truncated result", async () => {
    const fetch = fakeHttp(json({ contacts: [{ id: "one" }], total: 101 }));
    await expect(new GhlClient("fixture", "location", { fetch }).listContacts()).rejects.toThrow("pagination");
  });
  it("uses the additive tag endpoint, preserving unrelated tags", async () => {
    const fetch = fakeHttp(json({ tags: ["customer", "qualified"] }));
    const result = await new GhlClient("fixture", "location", { fetch, authorizeWrite: allowFixtureWrite }).addTags("contact", ["qualified", "qualified"]);
    expect(result.tags).toEqual(["customer", "qualified"]);
    expect(String(fetch.mock.calls[0][0])).toBe("https://services.leadconnectorhq.com/contacts/contact/tags");
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ tags: ["qualified"] });
    expect(fetch.mock.calls[0][1]!.method).toBe("POST");
  });
  it("creates a directory contact with a first name even when email and phone are absent", async () => {
    const fetch = fakeHttp(json({ contact: { id: "created", tags: [] } }, 201));
    await new GhlClient("fixture", "location", { fetch, authorizeWrite: allowFixtureWrite })
      .createDirectoryContact({ name: "Instagram Coach", companyName: "Instagram Coach", website: "https://example.test" });
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toMatchObject({
      firstName: "Instagram Coach", name: "Instagram Coach", companyName: "Instagram Coach", locationId: "location",
    });
  });
  it("validates contacts, notes, tasks and opportunity contracts", async () => {
    const fetch = fakeHttp(json({ contact: { id: "c", tags: [] } }), json({ notes: [{ id: "n", body: "fixture" }] }),
      json({ tasks: [{ id: "t", title: "Review" }] }), json({ opportunities: [{ id: "o", pipelineStageId: "identified" }] }),
      json({ opportunity: { id: "o", pipelineStageId: "qualified" } }),
      json({ pipelines: [{ id: "p", name: "PT Affiliate Pipeline", stages: [{ id: "qualified", name: "Qualified" }] }] }));
    const client = new GhlClient("fixture", "location", { fetch, authorizeWrite: allowFixtureWrite });
    expect((await client.getContact("c")).id).toBe("c");
    expect(await client.listNotes("c")).toHaveLength(1);
    expect(await client.listTasks("c")).toHaveLength(1);
    expect(await client.listOpportunities()).toHaveLength(1);
    expect((await client.transitionOpportunity("o", "qualified")).opportunity.pipelineStageId).toBe("qualified");
    expect((await client.listPipelines())[0].stages[0].name).toBe("Qualified");
  });
});

describe("Apify contracts", () => {
  it("starts, polls and reads paginated datasets with cost metadata", async () => {
    const fetch = fakeHttp(json({ data: { id: "r", status: "READY" } }),
      json({ data: { id: "r", status: "SUCCEEDED", defaultDatasetId: "d", usageTotalUsd: 0.02 } }),
      json(Array.from({ length: 1000 }, (_, i) => ({ username: `pt${i}` }))), json([{ username: "last" }]), json({ result: "fixture" }));
    const client = new ApifyClient("fixture", { fetch, authorizeWrite: allowFixtureWrite });
    expect((await client.startActor("owner/actor", {})).status).toBe("READY");
    expect((await client.getRun("r")).usageTotalUsd).toBe(0.02);
    expect(await client.readDataset("d", z.object({ username: z.string() }))).toHaveLength(1001);
    expect(String(fetch.mock.calls[3][0])).toContain("offset=1000");
    expect(await client.readRunKeyValueRecord("r", "RUN_REPORT", z.object({ result: z.string() }))).toEqual({ result: "fixture" });
    expect(String(fetch.mock.calls[4][0])).toContain("/actor-runs/r/key-value-store/records/RUN_REPORT");
  });
  it("keeps ambiguous actor starts pending reconciliation", async () => {
    const fetch = fakeHttp(json({}, 503));
    await expect(new ApifyClient("fixture", { fetch, authorizeWrite: allowFixtureWrite }).startActor("actor", {})).rejects.toThrow("unknown_outcome");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

const profile = { platform: "instagram", username: "coach", displayName: "Coach", bio: "Australian PT", followerCount: 1200,
  postCount: 20, lastPostAt: null, location: "Sydney", source: "fixture" };
const aiResponse = (text: string) => ({ id: "response-fixture", status: "completed", output: [
  { type: "message", content: [{ type: "output_text", text }] },
] });
describe("OpenAI contracts", () => {
  it("records prompt version/input hash and derives routing from validated score", async () => {
    const fetch = fakeHttp(json(aiResponse('{"score":70,"reason":"Relevant PT profile"}')));
    const result = await new OpenAiClient("fixture", "fixture-model", { fetch, authorizeWrite: allowFixtureWrite }).qualify(profile);
    expect(result).toMatchObject({ status: "qualified", promptVersion: "pt-affiliate-v1", model: "fixture-model" });
    expect(result.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toMatchObject({ store: false, text: { format: { type: "json_schema", strict: true } } });
  });
  it.each(['{"score":101,"reason":"bad"}', '{"score":70}', 'not-json', '{"score":"70","reason":"bad"}'])
    ("rejects malformed AI content %s", async (text) => {
      const fetch = fakeHttp(json(aiResponse(text)));
      await expect(new OpenAiClient("fixture", "fixture-model", { fetch, authorizeWrite: allowFixtureWrite }).qualify(profile)).rejects.toThrow("invalid_response");
    });
  it("rejects refusal and incomplete responses", async () => {
    const fetch = fakeHttp(json({ id: "r", status: "completed", output: [{ type: "message", content: [{ type: "refusal" }] }] }),
      json({ id: "r", status: "incomplete", output: [] }));
    const client = new OpenAiClient("fixture", "fixture-model", { fetch, authorizeWrite: allowFixtureWrite });
    await expect(client.qualify(profile)).rejects.toThrow("permanent");
    await expect(client.qualify(profile)).rejects.toThrow("invalid_response");
  });
});
describe("Slack contracts", () => {
  it("opens and verifies a direct-message channel for the exact member", async () => {
    const fetch = fakeHttp(json({ ok: true, channel: { id: "DPRIVATE123" } }));
    const result = await new SlackClient("fixture", "C123", { fetch, authorizeWrite: allowFixtureWrite }).openDirectMessage("U09N5128R0T");
    expect(result).toBe("DPRIVATE123");
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ users: "U09N5128R0T" });
  });
  it("detects HTTP-200 API failures without exposing provider errors", async () => {
    const fetch = fakeHttp(json({ ok: false, error: "synthetic-private-data" }));
    await expect(new SlackClient("fixture", "C123", { fetch, authorizeWrite: allowFixtureWrite }).postMessage("Fixture")).rejects.toThrow("slack:permanent");
  });
  it("sends approval buttons identifying the exact immutable batch", async () => {
    const fetch = fakeHttp(json({ ok: true, channel: "C123", ts: "123.456" }));
    const batchId = "e26ee7ba-799d-4bb2-a04f-bb5eb565a601";
    const result = await new SlackClient("fixture", "C123", { fetch, authorizeWrite: allowFixtureWrite }).requestApproval(batchId, "Fixture summary");
    expect(result.messageId).toBe("123.456");
    const body = JSON.parse(fetch.mock.calls[0][1]!.body as string);
    expect(body.blocks[1].elements.map((button: { value: string }) => button.value)).toEqual([batchId, batchId]);
  });
});

it("requests explicit all-status pipeline totals for reporting", async () => {
  const fetch = fakeHttp(json({ opportunities: [] }));
  await new GhlClient("fixture", "location", { fetch }).listOpportunities({ pipelineId: "pipeline", status: "all" });
  const url = new URL(String(fetch.mock.calls[0][0]));
  expect(url.searchParams.get("status")).toBe("all");
  expect(url.searchParams.get("pipelineId")).toBe("pipeline");
});
