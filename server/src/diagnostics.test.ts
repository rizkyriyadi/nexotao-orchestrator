import assert from "node:assert/strict";
import test from "node:test";
import { summarizeDiagnostics, type DiagnosticInput } from "./diagnostics.js";

const base: DiagnosticInput = {
  generatedAt: "2026-07-10T00:00:00.000Z",
  installedAt: "2026-07-01T00:00:00.000Z",
  installTimestampSource: "first_start",
  storage: "local test",
  persistent: true,
  projects: [
    { created_at: "2026-07-01T00:05:00.000Z", last_active_at: "2026-07-09T00:00:00.000Z" },
  ],
  runs: [
    { status: "awaiting_approval", created_at: "2026-07-01T00:10:00.000Z", completed_at: null },
    { status: "completed", created_at: "2026-07-01T00:20:00.000Z", completed_at: "2026-07-01T00:30:00.000Z" },
    { status: "failed", created_at: "2026-07-09T00:10:00.000Z", completed_at: "2026-07-09T00:20:00.000Z" },
  ],
  runHistoryTruncated: false,
};

test("summarizes all five local funnel milestones", () => {
  const report = summarizeDiagnostics(base);

  assert.equal(report.funnel.install.reached, true);
  assert.equal(report.funnel.onboarding.reached, true);
  assert.equal(report.funnel.firstPlan.plannedRunCount, 3);
  assert.equal(report.funnel.firstSuccessfulRun.successfulRunCount, 1);
  assert.equal(report.funnel.returnUsage.firstAt, "2026-07-09T00:00:00.000Z");
  assert.deepEqual(report.runOutcomes, {
    total: 3,
    planning: 0,
    awaitingApproval: 1,
    running: 0,
    completed: 1,
    failed: 1,
    stopped: 0,
  });
});

test("the serialized report cannot contain source, prompt, path, or credential input", () => {
  const unsafe = {
    ...base,
    apiKey: "sk-secret",
    prompt: "private customer prompt",
    path: "/private/source.ts",
    output: "private source content",
  } as DiagnosticInput & Record<string, unknown>;
  const json = JSON.stringify(summarizeDiagnostics(unsafe));

  assert.doesNotMatch(json, /sk-secret|private customer prompt|private\/source|private source content/);
  assert.equal(JSON.parse(json).privacy.networkTelemetry, false);
});
