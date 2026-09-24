import { workflow } from "@workflow/vitest";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

const workflowDataDirectory = fileURLToPath(new URL(".workflow-data", import.meta.url));
const workflowOutputDirectory = fileURLToPath(new URL(".workflow-vitest", import.meta.url));

export default defineConfig({
  root,
  resolve: {
    alias: { "@": root },
  },
  plugins: [
    workflow({
      cwd: root,
      rootDir: root,
      dataDir: workflowDataDirectory,
      outDir: workflowOutputDirectory,
    }),
  ],
  test: {
    // Workflow's shared local world uses timestamped write probes; parallel suites
    // can collide on the same file and fail cleanup on Windows.
    fileParallelism: false,
    environment: "node",
    env: { MONITORING_ENABLED: "false", MONITORING_ALERTS_ENABLED: "false", IG_LIKE_ENABLED: "false" },
    include: ["lib/workflows/**/*.integration.test.ts"],
    testTimeout: 60_000,
  },
});



