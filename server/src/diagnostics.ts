import { Hono } from "hono";
import { dbLabel, dbMode } from "./driver.js";
import { orceStore, type Run } from "./orce/store.js";
import { projectStore, type Project } from "./projects.js";
import { deploymentBoundary } from "./security.js";

const INSTALLED_AT_KEY = "diagnostics_installed_at";
const INSTALL_SOURCE_KEY = "diagnostics_install_source";
const RUN_LIMIT_PER_PROJECT = 100_000;
const RETURN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface DiagnosticInput {
  generatedAt: string;
  installedAt: string;
  installTimestampSource: "first_start" | "legacy_project_created_at";
  storage: string;
  persistent: boolean;
  projects: Array<Pick<Project, "created_at" | "last_active_at">>;
  runs: Array<Pick<Run, "status" | "created_at" | "completed_at">>;
  runHistoryTruncated: boolean;
}

function first(values: Array<string | null | undefined>): string | null {
  return values.filter((value): value is string => Boolean(value)).sort()[0] ?? null;
}

/** Pure aggregation boundary: only timestamps, states, and counts may enter. */
export function summarizeDiagnostics(input: DiagnosticInput) {
  const planned = input.runs.filter((run) => run.status !== "planning");
  const successful = input.runs.filter((run) => run.status === "completed");
  const returnThreshold = new Date(new Date(input.installedAt).getTime() + RETURN_WINDOW_MS).toISOString();
  const activity = [
    ...input.projects.flatMap((project) => [project.created_at, project.last_active_at]),
    ...input.runs.flatMap((run) => [run.created_at, run.completed_at]),
  ];
  const returnAt = first(
    activity.filter((at): at is string => typeof at === "string" && at >= returnThreshold)
  );

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    privacy: {
      mode: "local_only",
      networkTelemetry: false,
      containsSecrets: false,
      containsSourceContent: false,
      containsUserPrompts: false,
      containsFilesystemPaths: false,
    },
    deployment: deploymentBoundary(),
    storage: {
      label: input.storage,
      persistent: input.persistent,
      runHistoryTruncated: input.runHistoryTruncated,
    },
    funnel: {
      install: {
        reached: true,
        firstAt: input.installedAt,
        timestampSource: input.installTimestampSource,
      },
      onboarding: {
        reached: input.projects.length > 0,
        firstAt: first(input.projects.map((project) => project.created_at)),
        projectCount: input.projects.length,
      },
      firstPlan: {
        reached: planned.length > 0,
        firstAt: first(planned.map((run) => run.created_at)),
        plannedRunCount: planned.length,
      },
      firstSuccessfulRun: {
        reached: successful.length > 0,
        firstAt: first(successful.map((run) => run.completed_at)),
        successfulRunCount: successful.length,
      },
      returnUsage: {
        reached: returnAt !== null,
        firstAt: returnAt,
        definition: "local activity at least 7 days after install",
      },
    },
    runOutcomes: {
      total: input.runs.length,
      planning: input.runs.filter((run) => run.status === "planning").length,
      awaitingApproval: input.runs.filter((run) => run.status === "awaiting_approval").length,
      running: input.runs.filter((run) => run.status === "running").length,
      completed: successful.length,
      failed: input.runs.filter((run) => run.status === "failed").length,
      stopped: input.runs.filter((run) => run.status === "stopped").length,
    },
  };
}

export async function initDiagnostics(): Promise<void> {
  if (await projectStore.getSetting(INSTALLED_AT_KEY)) return;

  const projects = await projectStore.list();
  const legacyInstalledAt = first(projects.map((project) => project.created_at));
  await projectStore.setSetting(INSTALLED_AT_KEY, legacyInstalledAt ?? new Date().toISOString());
  await projectStore.setSetting(
    INSTALL_SOURCE_KEY,
    legacyInstalledAt ? "legacy_project_created_at" : "first_start"
  );
}

async function buildDiagnosticExport() {
  const generatedAt = new Date().toISOString();
  const installedAt = (await projectStore.getSetting(INSTALLED_AT_KEY)) ?? generatedAt;
  const source = await projectStore.getSetting(INSTALL_SOURCE_KEY);
  const projects = await projectStore.list();
  const runGroups = await Promise.all(
    projects.map((project) => orceStore.listRuns(project.id, RUN_LIMIT_PER_PROJECT))
  );
  const runs = runGroups.flat();

  return summarizeDiagnostics({
    generatedAt,
    installedAt,
    installTimestampSource: source === "legacy_project_created_at" ? source : "first_start",
    storage: dbLabel(),
    persistent: dbMode() !== "memory",
    projects,
    runs,
    runHistoryTruncated: runGroups.some((group) => group.length === RUN_LIMIT_PER_PROJECT),
  });
}

export const diagnosticsRoute = new Hono();

// Mounted under the authenticated API. The report is generated on demand and
// never sent anywhere by Orce.
diagnosticsRoute.get("/diagnostics/export", async (c) => {
  c.header("Cache-Control", "no-store");
  c.header("Content-Disposition", 'attachment; filename="nexotao-orce-diagnostics.json"');
  return c.json(await buildDiagnosticExport());
});
