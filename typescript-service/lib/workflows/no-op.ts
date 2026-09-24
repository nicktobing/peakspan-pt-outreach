export async function recordSmokeStep(correlationId: string) {
  "use step";
  return {
    correlationId,
    executedAt: new Date().toISOString(),
    outboundActions: 0,
  };
}

export async function noOpWorkflow(correlationId: string) {
  "use workflow";
  return recordSmokeStep(correlationId);
}
