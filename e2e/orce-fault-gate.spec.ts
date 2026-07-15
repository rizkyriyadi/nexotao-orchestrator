import { expect, test, type Page, type Route } from "@playwright/test";

const project = {
  id: "project-1",
  name: "Fault gate",
  path: "/tmp/orce-fault-gate",
  kind: "fresh",
  model: null,
  created_at: "2026-07-15T00:00:00.000Z",
  last_active_at: "2026-07-15T00:00:00.000Z",
};

const task = {
  id: "task-1",
  ticket: "TASK-0001",
  key: "verify",
  title: "Verify the release gate",
  agentLabel: "Generalist",
  dependsOn: [],
  status: "pending",
};

function sse(events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

async function fulfillJson(route: Route, body: unknown) {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

async function mockConsole(page: Page, mode: "happy" | "recovery") {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());

    if (pathname === "/api/auth/status") return fulfillJson(route, { needsSetup: false });
    if (pathname === "/api/me") return fulfillJson(route, {
      cwd: project.path,
      permissionMode: "default",
      dangerousMode: true,
      dangerousModeAcknowledged: true,
      sessionTtlSeconds: 43_200,
      deployment: { mode: "local_only", safeLocalOnly: true, warnings: [] },
      needsOnboarding: false,
      provider: "nexotao",
      providerReady: true,
      project,
    });
    if (pathname === "/api/projects") return fulfillJson(route, { projects: [project], activeId: project.id });
    if (pathname === "/api/sessions") return fulfillJson(route, []);

    if (pathname === "/api/orce/plan") return fulfillJson(route, {
      runId: "run-1", goal: "ship safely", budgetUsd: 1, images: [], tasks: [task],
    });
    if (pathname === "/api/orce/runs/run-1/start") {
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: sse([
        { type: "run_start", runId: "run-1", goal: "ship safely", budgetUsd: 1, images: [] },
        { type: "plan", tasks: [task] },
        { type: "task_status", id: task.id, status: "running" },
        { type: "task_delta", id: task.id, ev: { type: "text_delta", text: "gate passed" } },
        { type: "task_delta", id: task.id, ev: { type: "result", text: "gate passed", costUsd: 0.1 } },
        { type: "task_status", id: task.id, status: "done" },
        { type: "budget", spent: 0.1, limit: 1, warn: false, stopped: false },
        { type: "run_done", status: "completed", costUsd: 0.1 },
      ]) });
    }
    if (pathname === "/api/orce/runs/run-recovery/stream") {
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: sse([
        { type: "run_start", runId: "run-recovery", goal: "recover safely", budgetUsd: 1, images: [] },
        { type: "plan", tasks: [{ ...task, status: "running" }] },
        { type: "task_status", id: task.id, status: "needs_attention" },
        { type: "error", message: "Provider timeout after dispatch; reconcile usage before retrying." },
      ]) });
    }
    if (pathname === "/api/orce/active") {
      return fulfillJson(route, { active: mode === "recovery" ? ["run-recovery"] : [] });
    }
    if (pathname === "/api/orce/runs") {
      return fulfillJson(route, mode === "recovery" ? [{
        id: "run-recovery", goal: "recover safely", status: "running", cost_usd: 0,
        error: null, attachments: [], created_at: "2026-07-15T00:00:00.000Z", completed_at: null,
      }] : []);
    }

    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: `unmocked ${pathname}` }) });
  });
}

test("review-first happy path completes and keeps dangerous mode visible", async ({ page }) => {
  await mockConsole(page, "happy");
  await page.goto("/");
  await expect(page.getByText("DANGEROUS MODE ACKNOWLEDGED")).toBeVisible();

  await page.locator("nav").getByRole("button", { name: "Orchestrate" }).click();
  await page.getByPlaceholder(/build a Next\.js landing page/).fill("ship safely");
  await page.getByPlaceholder("none").fill("1");
  await page.getByRole("button", { name: "Plan", exact: true }).click();
  await expect(page.getByText(/Plan ready — 1 task/)).toBeVisible();
  await expect(page.getByText(task.title)).toBeVisible();

  await page.getByRole("button", { name: "Approve & run" }).click();
  await expect(page.getByText("completed · $0.1000")).toBeVisible();
  await expect(page.getByText("gate passed")).toBeVisible();
});

test("refresh recovery reconnects and surfaces ambiguous provider usage", async ({ page }) => {
  await mockConsole(page, "recovery");
  await page.goto("/");
  await page.locator("nav").getByRole("button", { name: "Orchestrate" }).click();

  await expect(page.getByText("operator reconciliation required")).toBeVisible();
  await expect(page.getByText(/Provider timeout after dispatch/)).toBeVisible();
  await expect(page.getByText("needs_attention ⤢")).toBeVisible();
});
