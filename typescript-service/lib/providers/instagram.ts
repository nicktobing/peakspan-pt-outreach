import type { LeadCandidate } from "../domain/normalization";

export type ProviderHealth = { healthy: boolean; reason?: "disabled" | "authentication" | "unavailable" };
export type ProviderRunReference = { provider: string; externalId: string };
export type ProviderRunStatus = { state: "pending" | "running" | "succeeded" | "failed" | "unknown";
  externalId: string; costUsd: number | null; messageId?: string };
export type ActionInput = { contactId: string; username: string; idempotencyKey: string };
export interface InstagramDiscoveryProvider { discover(source: string): Promise<LeadCandidate[]> }
export interface InstagramActionProvider {
  validateCredentials(): Promise<ProviderHealth>;
  getStatus(reference: ProviderRunReference): Promise<ProviderRunStatus>;
}
export interface InstagramFollowProvider extends InstagramActionProvider { follow(input: ActionInput): Promise<ProviderRunReference> }
export interface InstagramCommentProvider extends InstagramActionProvider { comment(input: ActionInput & { postUrl: string; text: string }): Promise<ProviderRunReference> }
export interface InstagramDmProvider extends InstagramActionProvider { send(input: ActionInput & { text: string }): Promise<ProviderRunReference> }
export interface InstagramInboxProvider {
  read(cursor?: string): Promise<{ messages: { id: string; username: string; receivedAt: string; preview: string }[]; nextCursor?: string }>;
}

