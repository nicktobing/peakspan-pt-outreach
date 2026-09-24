import { z } from "zod";
import { GhlClient } from "../clients/ghl";
import { SlackClient } from "../clients/slack";
import { ProviderError } from "../clients/errors";
import { getDb } from "../db/client";
import { MonitoringRepository } from "../db/monitoring";
import { getMonitoringConfig } from "../config/monitoring";
import { executeMonitoringRun } from "./service";
import type { AlertPayload } from "./contracts";

function providerValue(name: string) {
  const parsed = z.string().min(1).safeParse(process.env[name]);
  if (!parsed.success) throw new Error("Missing monitoring provider configuration");
  return parsed.data;
}

export async function executeMonitoring(businessRunId: string) {
  if (!getMonitoringConfig().enabled) return { disabled: true as const };
  const repository = new MonitoringRepository(getDb());
  const config = getMonitoringConfig();
  return executeMonitoringRun(repository, businessRunId, {
    // Resolve provider configuration lazily: reply/SLA jobs need no GHL access.
    get pipelineId() { return providerValue("GHL_PIPELINE_ID"); },
    opportunities: async () => new GhlClient(providerValue("GHL_API_TOKEN"), providerValue("GHL_LOCATION_ID"))
      .listOpportunities({ pipelineId: providerValue("GHL_PIPELINE_ID"), status: "all" }),
    replies: () => repository.pendingReplies(),
  }, {
    enabled: () => getMonitoringConfig().alertsEnabled,
    send: async (payload: AlertPayload) => {
      if (!getMonitoringConfig().alertsEnabled) throw new ProviderError("slack", "disabled");
      const slack = new SlackClient(providerValue("SLACK_BOT_TOKEN"), providerValue("SLACK_CHANNEL_OUTREACH"), {
        authorizeWrite: async () => getMonitoringConfig().alertsEnabled,
      });
      return slack.postMessage(payload.text);
    },
  }, { enabled: () => getMonitoringConfig().enabled, businessHours: config.businessHours });
}

export async function recordMonitoringFailure(businessRunId: string) {
  if (!getMonitoringConfig().enabled) return;
  await new MonitoringRepository(getDb()).fail(businessRunId);
}


