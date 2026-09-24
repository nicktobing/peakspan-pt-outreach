import { z } from "zod";
import { GhlClient } from "../clients/ghl";
import { ApifyClient } from "../clients/apify";
import { OpenAiClient } from "../clients/openai";
import { SlackClient } from "../clients/slack";
import { ProviderError } from "../clients/errors";
import { DmDisabledProvider } from "../providers/dm-disabled";

const configSchema = z.object({ GHL_API_TOKEN: z.string().min(1), GHL_LOCATION_ID: z.string().min(1),
  APIFY_API_TOKEN: z.string().min(1), OPENAI_API_KEY: z.string().min(1), OPENAI_MODEL: z.string().min(1),
  SLACK_BOT_TOKEN: z.string().min(1), SLACK_CHANNEL_OUTREACH: z.string().min(1) });

// Explicit construction only; no secrets are read or network calls made at import
// time. Milestone 2 composition intentionally supplies no mutation authorization.
export function createReadOnlyClients(source: NodeJS.ProcessEnv = process.env) {
  const parsed = configSchema.safeParse(source);
  if (!parsed.success) throw new ProviderError("configuration", "invalid_input");
  const env = parsed.data;
  return {
    ghl: new GhlClient(env.GHL_API_TOKEN, env.GHL_LOCATION_ID),
    apify: new ApifyClient(env.APIFY_API_TOKEN),
    openai: new OpenAiClient(env.OPENAI_API_KEY, env.OPENAI_MODEL),
    slack: new SlackClient(env.SLACK_BOT_TOKEN, env.SLACK_CHANNEL_OUTREACH),
    dm: new DmDisabledProvider(),
  };
}

