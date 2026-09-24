import { z } from "zod";
import { ProviderError } from "./errors";

export type TransportOptions = {
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  // Required for every mutation, including paid AI requests. Absent => blocked.
  authorizeWrite?: () => Promise<boolean>;
};

export class JsonClient {
  constructor(private readonly provider: string, private readonly baseUrl: string,
    private readonly headers: Record<string, string>, private readonly options: TransportOptions = {}) {}

  async request<T>(path: string, schema: z.ZodType<T>, input: {
    method?: "GET" | "POST" | "PUT" | "DELETE";
    body?: unknown;
    readOnly?: boolean;
    // Only use for semantically idempotent operations (e.g. additive tags).
    idempotent?: boolean;
  } = {}): Promise<T> {
    const method = input.method ?? "GET";
    const readOnly = input.readOnly ?? method === "GET";
    const retrySafe = readOnly || input.idempotent === true;
    if (!path.startsWith("/") || path.startsWith("//")) throw new ProviderError(this.provider, "invalid_input");
    const url = new URL(this.baseUrl + path);
    const send = this.options.fetch ?? fetch;
    const sleep = this.options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!readOnly && !(await this.options.authorizeWrite?.())) throw new ProviderError(this.provider, "disabled");
      let response: Response;
      try {
        response = await send(url, {
          method, redirect: "error", signal: AbortSignal.timeout(15_000),
          headers: { "Content-Type": "application/json", ...this.headers },
          body: input.body === undefined ? undefined : JSON.stringify(input.body),
        });
      } catch {
        if (retrySafe && attempt < 2) { await sleep(250 * 2 ** attempt); continue; }
        throw new ProviderError(this.provider, retrySafe ? "transient" : "unknown_outcome");
      }
      if (!response.ok) {
        const status = response.status;
        await response.body?.cancel().catch(() => {});
        const temporary = status === 429 || status === 408 || status >= 500;
        if (temporary && retrySafe && attempt < 2) {
          const header = response.headers.get("retry-after");
          const seconds = header === null ? NaN : Number(header);
          const delay = Number.isFinite(seconds) ? seconds * 1000 : header ? Date.parse(header) - Date.now() : NaN;
          // Do not retry earlier than Retry-After. Long waits belong in durable orchestration.
          if (Number.isFinite(delay) && delay > 30_000) throw new ProviderError(this.provider, "transient", status);
          await sleep(Number.isFinite(delay) ? Math.max(0, delay) : 250 * 2 ** attempt);
          continue;
        }
        throw new ProviderError(this.provider, status === 401 || status === 403 ? "authentication" : temporary
          ? (retrySafe ? "transient" : "unknown_outcome") : "permanent", status);
      }
      try {
        const value: unknown = await response.json();
        const parsed = schema.safeParse(value);
        if (parsed.success) return parsed.data;
      } catch { /* provider data must never escape in errors */ }
      throw new ProviderError(this.provider, readOnly ? "invalid_response" : "unknown_outcome");
    }
    throw new ProviderError(this.provider, "transient");
  }
}

export function parseInput<T>(provider: string, schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ProviderError(provider, "invalid_input");
  return parsed.data;
}

export function resourceId(value: string) {
  return encodeURIComponent(parseInput("client", z.string().regex(/^[a-zA-Z0-9_-]+$/).max(200), value));
}
