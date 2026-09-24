import { z } from "zod";
import { JsonClient, parseInput, resourceId, type TransportOptions } from "./http";
import { ProviderError } from "./errors";

const run = z.object({ id: z.string().min(1), status: z.enum([
  "READY", "RUNNING", "SUCCEEDED", "FAILED", "TIMING-OUT", "TIMED-OUT", "ABORTING", "ABORTED",
]), defaultDatasetId: z.string().optional(), usageTotalUsd: z.number().nonnegative().optional() });

export class ApifyClient {
  private readonly http: JsonClient;
  constructor(token: string, options: TransportOptions = {}) {
    parseInput("apify", z.string().min(1), token);
    this.http = new JsonClient("apify", "https://api.apify.com/v2", { Authorization: `Bearer ${token}` }, options);
  }
  async startActor(actorId: string, input: Record<string, unknown>) {
    const actor = parseInput("apify", z.string().regex(/^[\w-]+(?:[~\/][\w-]+)?$/), actorId).replace("/", "~");
    const body = parseInput("apify", z.record(z.string(), z.unknown()), input);
    return (await this.http.request(`/acts/${encodeURIComponent(actor)}/runs`, z.object({ data: run }), { method: "POST", body })).data;
  }
  async getRun(runId: string) {
    return (await this.http.request(`/actor-runs/${resourceId(runId)}`, z.object({ data: run }))).data;
  }
  async readRunKeyValueRecord<T>(runId: string, key: string, schema: z.ZodType<T>) {
    const recordKey = parseInput("apify", z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), key);
    return this.http.request(`/actor-runs/${resourceId(runId)}/key-value-store/records/${encodeURIComponent(recordKey)}`, schema);
  }
  async readDataset<T>(datasetId: string, itemSchema: z.ZodType<T>) {
    const result: T[] = [];
    for (let offset = 0; offset < 1_000_000; offset += 1000) {
      const items = await this.http.request(`/datasets/${resourceId(datasetId)}/items?format=json&offset=${offset}&limit=1000`, z.array(itemSchema));
      result.push(...items);
      if (items.length < 1000) return result;
    }
    throw new ProviderError("apify", "pagination");
  }
  // Intentionally bounded, not a complete dataset read. Useful for single-action contracts.
  async readDatasetHead<T>(datasetId: string, itemSchema: z.ZodType<T>, limit: number) {
    parseInput("apify", z.number().int().min(1).max(100), limit);
    return this.http.request(`/datasets/${resourceId(datasetId)}/items?format=json&offset=0&limit=${limit}`, z.array(itemSchema).max(limit));
  }
}
