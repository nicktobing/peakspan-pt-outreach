import { z } from "zod";
import { JsonClient, parseInput, type TransportOptions } from "./http";
import { ProviderError } from "./errors";

const resultSchema = z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), channel: z.string(), ts: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() })]);
export class SlackClient {
  private readonly http: JsonClient;
  constructor(token: string, private readonly channel: string, options: TransportOptions = {}) {
    parseInput("slack", z.string().min(1), token); parseInput("slack", z.string().regex(/^[A-Z0-9]+$/), channel);
    this.http = new JsonClient("slack", "https://slack.com/api", { Authorization: `Bearer ${token}` }, options);
  }
  async postMessage(text: string) { return this.send(parseInput("slack", z.string().trim().min(1).max(4000), text)); }
  async openDirectMessage(memberId: string) {
    const user = parseInput("slack", z.string().regex(/^U[A-Z0-9]+$/), memberId);
    const result = await this.http.request("/conversations.open", z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), channel: z.object({ id: z.string().regex(/^D[A-Z0-9]+$/) }) }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]), { method: "POST", idempotent: true, body: { users: user } });
    if (!result.ok) throw new ProviderError("slack", ["invalid_auth", "not_authed", "token_revoked"].includes(result.error) ? "authentication" : "permanent");
    return result.channel.id;
  }
  async identity() {
    const result = await this.http.request("/auth.test", z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), team: z.string(), team_id: z.string(), bot_id: z.string().optional() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]));
    if (!result.ok) throw new ProviderError("slack", "authentication");
    return { teamName: result.team, teamId: result.team_id, isBot: Boolean(result.bot_id) };
  }
  async requestApproval(batchId: string, summary: string) {
    parseInput("slack", z.string().uuid(), batchId);
    parseInput("slack", z.string().trim().min(1).max(2800), summary);
    return this.send(summary, [
      { type: "section", text: { type: "plain_text", text: summary } },
      { type: "actions", elements: [
        { type: "button", action_id: "dm_approve", text: { type: "plain_text", text: "Approve" }, value: batchId },
        { type: "button", action_id: "dm_reject", text: { type: "plain_text", text: "Reject" }, value: batchId },
      ] },
    ]);
  }
  private async send(text: string, blocks?: unknown[]) {
    const result = await this.http.request("/chat.postMessage", resultSchema, { method: "POST", body: {
      channel: this.channel, text, blocks, unfurl_links: false, unfurl_media: false,
    } });
    if (!result.ok) throw new ProviderError("slack", ["invalid_auth", "not_authed", "token_revoked"].includes(result.error) ? "authentication" : "permanent");
    return { channel: result.channel, messageId: result.ts };
  }
}

