import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const baseUrl = process.env.ORCE_CAPTURE_URL || "http://127.0.0.1:4173";
const outputDir = resolve("docs/images");
const now = "2026-07-15T10:30:00.000Z";

const project = {
  id: "project-demo",
  name: "Orce OSS Demo",
  path: "/workspace/orce-demo",
  kind: "imported",
  model: "claude-sonnet-4-5",
  created_at: "2026-07-14T08:00:00.000Z",
  last_active_at: now,
};

const sessions = [
  ["session-1", "Audit the orchestration lifecycle", "2026-07-15T10:27:00.000Z"],
  ["session-2", "Add idempotent run commands", "2026-07-15T09:48:00.000Z"],
  ["session-3", "Review the operator recovery flow", "2026-07-14T16:10:00.000Z"],
  ["session-4", "Map the repository architecture", "2026-07-14T11:20:00.000Z"],
].map(([id, title, updated_at]) => ({
  id,
  title,
  sdk_session_id: `${id}-sdk`,
  created_at: updated_at,
  updated_at,
}));

const dbTasks = [
  {
    id: "task-1041",
    ticket: "TASK-1041",
    key: "invariants",
    title: "Map lifecycle invariants and failure states",
    prompt: "Document the legal run and task transitions. Cover retries, cancellation, and ambiguous provider outcomes.",
    agent_label: "Reliability",
    status: "done",
    depends_on: [],
    output: "Mapped the run state machine and documented every terminal transition. Added explicit recovery guidance for ambiguous dispatch outcomes.",
    cost_usd: 0.084,
    error: null,
    order_idx: 0,
  },
  {
    id: "task-1042",
    ticket: "TASK-1042",
    key: "commands",
    title: "Add idempotent lifecycle commands",
    prompt: "Implement idempotent start, retry, resume, and cancel commands with deterministic conflict handling and an immutable audit trail.",
    agent_label: "Backend",
    status: "done",
    depends_on: ["invariants"],
    output: "Implemented idempotent lifecycle commands with command keys, atomic state transitions, and immutable operator audit events. Focused regression tests pass.",
    cost_usd: 0.132,
    error: null,
    order_idx: 1,
  },
  {
    id: "task-1043",
    ticket: "TASK-1043",
    key: "recovery",
    title: "Verify recovery after provider timeout",
    prompt: "Exercise the ambiguous provider-dispatch path and prove the operator sees a safe reconciliation action instead of a silent retry.",
    agent_label: "QA",
    status: "needs_attention",
    depends_on: ["commands"],
    output: null,
    cost_usd: null,
    error: "Provider timeout after dispatch; reconcile usage before retrying.",
    order_idx: 2,
  },
  {
    id: "task-1044",
    ticket: "TASK-1044",
    key: "release",
    title: "Publish the reliability gate report",
    prompt: "Summarize the verified invariants, focused tests, and remaining operator reconciliation step.",
    agent_label: "Docs",
    status: "pending",
    depends_on: ["recovery"],
    output: null,
    cost_usd: null,
    error: null,
    order_idx: 3,
  },
];

const taskMeta = dbTasks.map((task) => ({
  id: task.id,
  ticket: task.ticket,
  key: task.key,
  title: task.title,
  agentLabel: task.agent_label,
  dependsOn: task.depends_on,
  status: "pending",
}));

const run = {
  id: "run-reliability",
  goal: "Harden Orce lifecycle reliability and make recovery states operator-friendly",
  status: "needs_attention",
  cost_usd: 0.216,
  error: "One task needs operator reconciliation before the run can continue.",
  attachments: [],
  created_at: "2026-07-15T09:40:00.000Z",
  completed_at: null,
};

const events = [
  ["event-1", "task-1041", "info", "TASK-1041 · lifecycle invariants verified", "2026-07-15T09:42:10.000Z"],
  ["event-2", "task-1042", "info", "TASK-1042 · idempotent command tests passed", "2026-07-15T09:55:24.000Z"],
  ["event-3", "task-1043", "warn", "TASK-1043 · provider outcome needs reconciliation", "2026-07-15T10:02:41.000Z"],
].map(([id, task_id, level, message, created_at]) => ({ id, task_id, type: "task", level, message, created_at }));

const allTasks = dbTasks.map((task) => ({ ...task, run_id: run.id, run_goal: run.goal }));

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function mockApi(page) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname, searchParams } = url;

    if (pathname === "/api/auth/status") return json(route, { needsSetup: false });
    if (pathname === "/api/me") {
      return json(route, {
        cwd: project.path,
        permissionMode: "acceptEdits",
        dangerousMode: false,
        dangerousModeAcknowledged: false,
        sessionTtlSeconds: 43_200,
        deployment: { mode: "local_only", safeLocalOnly: true, warnings: [] },
        needsOnboarding: false,
        provider: "nexotao",
        providerReady: true,
        project,
      });
    }
    if (pathname === "/api/projects") return json(route, { projects: [project], activeId: project.id });
    if (pathname === "/api/sessions") return json(route, sessions);
    if (pathname === "/api/stats") {
      return json(route, {
        sessions: sessions.length,
        messages: 28,
        lastActivityAt: "2026-07-15T10:27:00.000Z",
        cwd: project.path,
        permissionMode: "acceptEdits",
        dbConnected: true,
        storage: "embedded PostgreSQL",
      });
    }
    if (pathname === "/api/sessions/session-1/messages") {
      return json(route, {
        session: sessions[0],
        streaming: false,
        messages: [
          {
            id: "message-1",
            role: "user",
            content: [{ kind: "text", text: "Audit the lifecycle commands and run the focused regression tests." }],
            created_at: "2026-07-15T10:20:00.000Z",
          },
          {
            id: "message-2",
            role: "assistant",
            content: [
              { kind: "text", text: "I traced the command path and checked the state-machine boundaries." },
              { kind: "tool", id: "tool-1", name: "Bash", input: { command: "npm test -- lifecycle" }, result: "18 tests passed", isError: false },
              { kind: "text", text: "The focused suite passes. Duplicate start/retry commands now resolve deterministically, and ambiguous provider usage moves the task to needs_attention for operator reconciliation." },
            ],
            created_at: "2026-07-15T10:27:00.000Z",
          },
        ],
      });
    }
    if (pathname === "/api/orce/runs") return json(route, [run]);
    if (pathname === "/api/orce/active") return json(route, { active: [] });
    if (pathname === "/api/orce/tasks") return json(route, allTasks);
    if (pathname === `/api/orce/runs/${run.id}`) return json(route, { run, tasks: dbTasks, events });
    if (pathname === "/api/orce/plan") {
      return json(route, {
        runId: "run-plan",
        goal: "Ship a safe lifecycle command layer with regression coverage",
        budgetUsd: 2,
        images: [],
        tasks: taskMeta,
      });
    }
    if (pathname === "/api/fs/list") {
      const path = searchParams.get("path") || "";
      return json(route, {
        path,
        root: project.path,
        items: [
          { name: "docs", type: "dir", size: 0, mtime: now },
          { name: "server", type: "dir", size: 0, mtime: now },
          { name: "web", type: "dir", size: 0, mtime: now },
          { name: "README.md", type: "file", size: 2184, mtime: now },
          { name: "ROADMAP.md", type: "file", size: 1498, mtime: now },
          { name: "package.json", type: "file", size: 1312, mtime: now },
        ],
      });
    }
    if (pathname === "/api/fs/read") {
      return json(route, {
        path: searchParams.get("path") || "README.md",
        size: 2184,
        content: `# Nexotao Orce\n\nLocal-first multi-agent orchestration for real engineering work.\n\n## Reliability first\n\n- Review a task DAG before execution\n- Run independent agents in parallel\n- Enforce hard budget boundaries\n- Resume safely with idempotent commands\n- Surface ambiguous provider outcomes for operator reconciliation\n\n## Quick start\n\n\`\`\`bash\nnpx nexotao-orce\n\`\`\`\n`,
      });
    }

    return json(route, { error: `Unmocked capture route: ${pathname}` }, 404);
  });
}

async function settle(page) {
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
}

async function capture(page, name) {
  await settle(page);
  await page.screenshot({ path: resolve(outputDir, name), animations: "disabled" });
}

async function navigate(page, label) {
  const clicked = await page.evaluate((target) => {
    const button = [...document.querySelectorAll("nav button")].find((candidate) =>
      candidate.textContent?.trim().endsWith(target),
    );
    button?.click();
    return Boolean(button);
  }, label);
  if (!clicked) throw new Error(`Navigation item not found: ${label}`);
  await page.waitForTimeout(100);
}

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 960 },
  deviceScaleFactor: 1,
  colorScheme: "dark",
  reducedMotion: "reduce",
});
await mockApi(page);

await page.goto(baseUrl);
await capture(page, "dashboard.png");

await navigate(page, "Chat");
await page.getByRole("button", { name: /Audit the orchestration lifecycle/ }).click();
await capture(page, "chat.png");

await navigate(page, "Orchestrate");
await page.getByPlaceholder(/build a Next\.js landing page/).fill("Ship a safe lifecycle command layer with regression coverage");
await page.getByPlaceholder("none").fill("2");
await page.getByRole("button", { name: "Plan", exact: true }).click();
await page.getByText("Plan ready — 4 tasks").waitFor();
await capture(page, "plan-approval.png");

await navigate(page, "Runs");
await page.getByRole("button", { name: /Harden Orce lifecycle reliability/ }).click();
await page.getByText("One task needs operator reconciliation before the run can continue.").waitFor();
await capture(page, "orchestration.png");

await navigate(page, "Tasks");
await page.getByText("4 across all runs").waitFor();
await capture(page, "tasks.png");

await page.getByRole("button", { name: /TASK-1042/ }).click();
await page.getByText("task brief").waitFor();
await capture(page, "task-detail.png");

await navigate(page, "Files");
await page.getByRole("button", { name: /README\.md/ }).click();
await page.getByText("Reliability first").waitFor();
await capture(page, "files.png");

await browser.close();
console.log(`Captured documentation images in ${outputDir}`);
