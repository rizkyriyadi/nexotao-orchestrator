import assert from "node:assert/strict";
import test from "node:test";
import {
  generateValidatedPlan,
  PlanValidationError,
  validatePlan,
  type PlannedTask,
  type PlanValidationCode,
} from "./plan-validation.js";

const agents = ["Implementer", "Reviewer"];
const limits = { maxNodes: 6, maxDepth: 4 };

function task(key: string, depends_on: string[] = [], agent = "Implementer"): PlannedTask {
  return { key, title: `Task ${key}`, prompt: `Complete ${key}`, agent, depends_on };
}

function codesFor(tasks: PlannedTask[], customLimits = limits): PlanValidationCode[] {
  try {
    validatePlan({ tasks }, agents, customLimits);
    return [];
  } catch (error) {
    assert(error instanceof PlanValidationError);
    return error.issues.map((issue) => issue.code);
  }
}

test("strict plan validation preserves valid task and dependency order", () => {
  const tasks = [task("research"), task("build", ["research"]), task("review", ["research", "build"], "Reviewer")];
  const validated = validatePlan({ tasks }, agents, limits);
  assert.deepEqual(validated.tasks, tasks);
  assert.deepEqual(validated.tasks[2].depends_on, ["research", "build"]);
  assert.equal(validated.depth, 3);
});

test("cyclic, dangling, duplicate, oversized, deep, and unknown-agent plans fail with offending graph data", () => {
  assert.deepEqual(codesFor([task("a", ["b"]), task("b", ["a"])]), ["cycle"]);
  assert.deepEqual(codesFor([task("a", ["missing"])]), ["dangling_dependency"]);
  assert(codesFor([task("same"), task("same")]).includes("duplicate_key"));
  assert.deepEqual(codesFor([task("a", [], "Ghost")]), ["unknown_agent"]);
  assert(codesFor([task("a"), task("b"), task("c")], { maxNodes: 2, maxDepth: 4 }).includes("node_limit_exceeded"));
  assert.deepEqual(
    codesFor([task("a"), task("b", ["a"]), task("c", ["b"])], { maxNodes: 6, maxDepth: 2 }),
    ["depth_limit_exceeded"]
  );

  assert.throws(
    () => validatePlan({ tasks: [task("a", ["missing"])] }, agents, limits),
    (error) => {
      assert(error instanceof PlanValidationError);
      assert.deepEqual(error.issues[0].nodes, ["a", "missing"]);
      assert.deepEqual(error.issues[0].edges, ["a->missing"]);
      return true;
    }
  );
});

test("schema rejects missing fields, extra fields, malformed keys, and non-JSON output", async () => {
  assert(codesFor([{ ...task("ok"), extra: true } as PlannedTask]).includes("invalid_schema"));
  assert(codesFor([task("Not a slug")]).includes("invalid_schema"));

  await assert.rejects(
    generateValidatedPlan("make a plan", agents, limits, async () => ({ text: "not json", costUsd: 0.1 })),
    (error) => {
      assert(error instanceof PlanValidationError);
      assert.equal(error.attempts, 2);
      assert.equal(error.issues[0].code, "invalid_json");
      return true;
    }
  );
});

test("invalid model output receives one structured correction retry", async () => {
  const prompts: string[] = [];
  const outputs = [
    JSON.stringify({ tasks: [task("build", [], "Ghost")] }),
    JSON.stringify({ tasks: [task("build")] }),
  ];
  const result = await generateValidatedPlan("base prompt", agents, limits, async (prompt, attempt) => {
    prompts.push(prompt);
    return { text: outputs[attempt - 1], costUsd: attempt * 0.1 };
  });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /"error":"invalid_plan"/);
  assert.match(prompts[1], /"code":"unknown_agent"/);
  assert.deepEqual(result.tasks, [task("build")]);
  assert(Math.abs(result.costUsd - 0.3) < Number.EPSILON);
});

test("second invalid output stops with an API-safe actionable problem", async () => {
  let calls = 0;
  await assert.rejects(
    generateValidatedPlan("base prompt", agents, limits, async () => {
      calls++;
      return { text: JSON.stringify({ tasks: [task("x", ["gone"])] }), costUsd: 0.25 };
    }),
    (error) => {
      assert(error instanceof PlanValidationError);
      assert.equal(calls, 2);
      assert.equal(error.costUsd, 0.5);
      assert.match(error.message, /after 2 attempts/);
      assert.match(error.message, /x.*gone/);
      assert.deepEqual(error.toResponse(), {
        code: "invalid_plan",
        error: error.message,
        attempts: 2,
        issues: error.issues,
      });
      return true;
    }
  );
});

test("deterministic fuzz: generated DAGs validate and injected bad edges always fail", () => {
  let seed = 0x5eed1234;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };

  for (let iteration = 0; iteration < 250; iteration++) {
    const size = 1 + Math.floor(random() * 12);
    const tasks: PlannedTask[] = [];
    for (let index = 0; index < size; index++) {
      const dependencies = index > 0 && random() > 0.35 ? [`node-${Math.floor(random() * index)}`] : [];
      tasks.push(task(`node-${index}`, dependencies));
    }
    const result = validatePlan({ tasks }, agents, { maxNodes: 12, maxDepth: 12 });
    assert.deepEqual(result.tasks.map((item) => item.key), tasks.map((item) => item.key));

    const broken = tasks.map((item) => ({ ...item, depends_on: [...item.depends_on] }));
    broken[broken.length - 1].depends_on = [`missing-${iteration}`];
    assert(codesFor(broken, { maxNodes: 12, maxDepth: 12 }).includes("dangling_dependency"));
  }
});
