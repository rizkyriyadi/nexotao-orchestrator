import { z } from "zod";

export interface PlanLimits {
  maxNodes: number;
  maxDepth: number;
}

export interface PlannedTask {
  key: string;
  title: string;
  prompt: string;
  agent: string;
  depends_on: string[];
}

export type PlanValidationCode =
  | "invalid_json"
  | "invalid_schema"
  | "node_limit_exceeded"
  | "duplicate_key"
  | "unknown_agent"
  | "duplicate_dependency"
  | "self_dependency"
  | "dangling_dependency"
  | "cycle"
  | "depth_limit_exceeded";

export interface PlanValidationIssue {
  code: PlanValidationCode;
  message: string;
  path?: string;
  nodes?: string[];
  edges?: string[];
}

export interface ValidatedPlan {
  tasks: PlannedTask[];
  depth: number;
}

export interface PlannerAttemptResult {
  text: string;
  costUsd: number;
}

export interface GeneratedPlan extends ValidatedPlan {
  costUsd: number;
}

export class PlanValidationError extends Error {
  readonly code = "invalid_plan" as const;

  constructor(
    public readonly issues: PlanValidationIssue[],
    public readonly attempts = 1,
    public readonly costUsd = 0
  ) {
    super(formatPlanValidationError(issues, attempts));
    this.name = "PlanValidationError";
  }

  toResponse() {
    return {
      code: this.code,
      error: this.message,
      attempts: this.attempts,
      issues: this.issues,
    };
  }
}

const taskSchema = z
  .object({
    key: z.string().min(1).max(64).regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, "must be a lowercase slug"),
    title: z.string().trim().min(1).max(160),
    prompt: z.string().trim().min(1).max(20_000),
    agent: z.string().trim().min(1).max(80),
    depends_on: z.array(z.string().min(1).max(64)),
  })
  .strict();

const planSchema = z.object({ tasks: z.array(taskSchema).min(1) }).strict();

function pathLabel(path: PropertyKey[]): string {
  return path.reduce<string>((result, part) => {
    if (typeof part === "number") return `${result}[${part}]`;
    return result ? `${result}.${String(part)}` : String(part);
  }, "");
}

function extractJson(text: string): { value?: unknown; issue?: PlanValidationIssue } {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  const raw = fence ? fence[1] : first >= 0 && last >= first ? text.slice(first, last + 1) : text;
  try {
    return { value: JSON.parse(raw.trim()) };
  } catch (error) {
    return {
      issue: {
        code: "invalid_json",
        message: `Planner response is not valid JSON: ${error instanceof Error ? error.message : "parse failed"}`,
      },
    };
  }
}

function cycleIssue(tasks: PlannedTask[]): PlanValidationIssue | null {
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (key: string): string[] | null => {
    if (visiting.has(key)) {
      const start = stack.indexOf(key);
      return [...stack.slice(start), key];
    }
    if (visited.has(key)) return null;
    visiting.add(key);
    stack.push(key);
    for (const dependency of byKey.get(key)?.depends_on ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(key);
    visited.add(key);
    return null;
  };

  for (const task of tasks) {
    const cycle = visit(task.key);
    if (cycle) {
      return {
        code: "cycle",
        message: `Dependency cycle detected: ${cycle.join(" -> ")}`,
        nodes: [...new Set(cycle)],
        edges: cycle.slice(0, -1).map((node, index) => `${node}->${cycle[index + 1]}`),
      };
    }
  }
  return null;
}

function graphDepth(tasks: PlannedTask[]): { depth: number; path: string[] } {
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  const memo = new Map<string, { depth: number; path: string[] }>();
  const depthOf = (key: string): { depth: number; path: string[] } => {
    const cached = memo.get(key);
    if (cached) return cached;
    const dependencies = byKey.get(key)?.depends_on ?? [];
    const deepest = dependencies.map(depthOf).sort((a, b) => b.depth - a.depth)[0];
    const result = deepest
      ? { depth: deepest.depth + 1, path: [...deepest.path, key] }
      : { depth: 1, path: [key] };
    memo.set(key, result);
    return result;
  };
  return tasks.map((task) => depthOf(task.key)).sort((a, b) => b.depth - a.depth)[0] ?? { depth: 0, path: [] };
}

export function validatePlan(raw: unknown, agentNames: readonly string[], limits: PlanLimits): ValidatedPlan {
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PlanValidationError(
      parsed.error.issues.map((issue) => ({
        code: "invalid_schema",
        message: `${pathLabel(issue.path)}: ${issue.message}`,
        path: pathLabel(issue.path),
      }))
    );
  }

  const tasks = parsed.data.tasks;
  const issues: PlanValidationIssue[] = [];
  if (tasks.length > limits.maxNodes) {
    issues.push({
      code: "node_limit_exceeded",
      message: `Plan has ${tasks.length} tasks; configured maximum is ${limits.maxNodes}`,
      path: "tasks",
      nodes: tasks.slice(limits.maxNodes).map((task) => task.key),
    });
  }

  const keyCounts = new Map<string, number>();
  for (const task of tasks) keyCounts.set(task.key, (keyCounts.get(task.key) ?? 0) + 1);
  for (const [key, count] of keyCounts) {
    if (count > 1) {
      issues.push({ code: "duplicate_key", message: `Task key "${key}" appears ${count} times`, nodes: [key] });
    }
  }

  const knownAgents = new Set(agentNames);
  const keys = new Set(tasks.map((task) => task.key));
  for (const task of tasks) {
    if (!knownAgents.has(task.agent)) {
      issues.push({
        code: "unknown_agent",
        message: `Task "${task.key}" names unknown agent "${task.agent}"; expected one of: ${agentNames.join(", ") || "none configured"}`,
        nodes: [task.key],
      });
    }
    const dependencies = new Set<string>();
    for (const dependency of task.depends_on) {
      const edge = `${task.key}->${dependency}`;
      if (dependencies.has(dependency)) {
        issues.push({
          code: "duplicate_dependency",
          message: `Task "${task.key}" repeats dependency "${dependency}"`,
          nodes: [task.key, dependency],
          edges: [edge],
        });
      }
      dependencies.add(dependency);
      if (dependency === task.key) {
        issues.push({
          code: "self_dependency",
          message: `Task "${task.key}" depends on itself`,
          nodes: [task.key],
          edges: [edge],
        });
      } else if (!keys.has(dependency)) {
        issues.push({
          code: "dangling_dependency",
          message: `Task "${task.key}" depends on missing task "${dependency}"`,
          nodes: [task.key, dependency],
          edges: [edge],
        });
      }
    }
  }

  if (!issues.some((issue) => ["duplicate_key", "self_dependency", "dangling_dependency"].includes(issue.code))) {
    const cycle = cycleIssue(tasks);
    if (cycle) issues.push(cycle);
    if (!cycle) {
      const deepest = graphDepth(tasks);
      if (deepest.depth > limits.maxDepth) {
        issues.push({
          code: "depth_limit_exceeded",
          message: `Dependency path ${deepest.path.join(" -> ")} has depth ${deepest.depth}; configured maximum is ${limits.maxDepth}`,
          nodes: deepest.path,
          edges: deepest.path.slice(0, -1).map((node, index) => `${deepest.path[index + 1]}->${node}`),
        });
      }
    }
  }

  if (issues.length) throw new PlanValidationError(issues);
  return { tasks, depth: graphDepth(tasks).depth };
}

export function formatPlanValidationError(issues: PlanValidationIssue[], attempts: number): string {
  const detail = issues.slice(0, 4).map((issue) => issue.message).join("; ");
  const suffix = issues.length > 4 ? `; plus ${issues.length - 4} more issue(s)` : "";
  return `Planner produced an invalid task graph after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${detail}${suffix}`;
}

export async function generateValidatedPlan(
  basePrompt: string,
  agentNames: readonly string[],
  limits: PlanLimits,
  runAttempt: (prompt: string, attempt: 1 | 2) => Promise<PlannerAttemptResult>
): Promise<GeneratedPlan> {
  let prompt = basePrompt;
  let totalCost = 0;
  let lastIssues: PlanValidationIssue[] = [];
  for (const attempt of [1, 2] as const) {
    const result = await runAttempt(prompt, attempt);
    totalCost += result.costUsd;
    const extracted = extractJson(result.text);
    try {
      if (extracted.issue) throw new PlanValidationError([extracted.issue]);
      const validated = validatePlan(extracted.value, agentNames, limits);
      return { ...validated, costUsd: totalCost };
    } catch (error) {
      if (!(error instanceof PlanValidationError)) throw error;
      lastIssues = error.issues;
      if (attempt === 2) break;
      const feedback = JSON.stringify({
        error: "invalid_plan",
        issues: lastIssues.map(({ code, message, path, nodes, edges }) => ({ code, message, path, nodes, edges })),
      });
      prompt =
        `${basePrompt}\n\nYour previous response was rejected by deterministic validation. ` +
        `Correct every issue below and return a complete replacement JSON object only.\n${feedback}`;
    }
  }
  throw new PlanValidationError(lastIssues, 2, totalCost);
}
