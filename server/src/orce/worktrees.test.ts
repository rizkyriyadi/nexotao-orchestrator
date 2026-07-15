import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { GitWorktreeManager } from "./worktrees.js";
import { PGlite } from "@electric-sql/pglite";
import { SqlOrceStore, type TaskInput } from "./store.js";
import type { SqlFn } from "./migrations.js";

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) { return (await exec("git", args, { cwd })).stdout.trim(); }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orce-worktrees-"));
  const repo = join(root, "project");
  await exec("git", ["init", repo]);
  await writeFile(join(repo, "shared.txt"), "base\n");
  await git(repo, "add", "shared.txt");
  await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"], { cwd: repo });
  return { root, repo, manager: new GitWorktreeManager(repo) };
}

function sqlFor(pg: PGlite): SqlFn {
  return async (strings, ...values) => {
    let text = strings[0];
    for (let index = 0; index < values.length; index++) text += `$${index + 1}${strings[index + 1]}`;
    return (await pg.query(text, values)).rows;
  };
}

test("parallel writers receive distinct real worktrees and overlapping integration never overwrites", async () => {
  const { root, repo, manager } = await fixture();
  try {
    const [first, second] = await Promise.all([manager.prepare("attempt-one", "worker-one"), manager.prepare("attempt-two", "worker-two")]);
    assert.notEqual(first.path, second.path);
    assert.equal(first.baseCommit, second.baseCommit);
    await Promise.all([writeFile(join(first.path, "shared.txt"), "first writer\n"), writeFile(join(second.path, "shared.txt"), "second writer\n")]);
    assert.equal(await readFile(join(repo, "shared.txt"), "utf8"), "base\n");
    const [firstArtifact, secondArtifact] = await Promise.all([manager.capture(first), manager.capture(second)]);
    assert.deepEqual(firstArtifact.changedFiles, ["shared.txt"]);
    assert.match(firstArtifact.diff, /first writer/);
    assert.equal((await manager.integrate(firstArtifact)).integrated, true);
    assert.deepEqual(await manager.integrate(secondArtifact), { integrated: false, reason: "overlapping changes: shared.txt" });
    assert.equal(await readFile(join(repo, "shared.txt"), "utf8"), "first writer\n");
    await Promise.all([manager.cleanup(first), manager.cleanup(second)]);
    await Promise.all([manager.cleanup(first), manager.cleanup(second)]);
    const worktrees = await git(repo, "worktree", "list", "--porcelain");
    assert(!worktrees.includes(first.path));
    assert(!worktrees.includes(second.path));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("disjoint attempts integrate sequentially from the same recorded base", async () => {
  const { root, repo, manager } = await fixture();
  try {
    const [first, second] = await Promise.all([manager.prepare("attempt-a", "worker-a"), manager.prepare("attempt-b", "worker-b")]);
    await writeFile(join(first.path, "a.txt"), "a\n");
    await writeFile(join(second.path, "b.txt"), "b\n");
    const [a, b] = await Promise.all([manager.capture(first), manager.capture(second)]);
    assert.equal((await manager.integrate(a)).integrated, true);
    assert.equal((await manager.integrate(b)).integrated, true);
    assert.equal(await readFile(join(repo, "a.txt"), "utf8"), "a\n");
    assert.equal(await readFile(join(repo, "b.txt"), "utf8"), "b\n");
    await manager.cleanup(first); await manager.cleanup(second);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("attempt worktree artifacts persist and terminal leftovers are discoverable for restart cleanup", async () => {
  const pg = new PGlite();
  await pg.waitReady;
  const store = new SqlOrceStore(sqlFor(pg));
  await store.init();
  const run = await store.createRun("00000000-0000-4000-8000-000000000017", "worktree persistence", null);
  await store.transitionRun(run.id, "awaiting_approval", { actorType: "test" });
  const input: TaskInput = {
    run_id: run.id, key: "writer", title: "Writer", prompt: "write", agent_id: null,
    agent_label: "Implementer", status: "pending", depends_on: [], output: null,
    cost_usd: null, error: null, order_idx: 0,
  };
  const task = await store.createTask(input);
  const claim = await store.claimTask({
    taskId: task.id, idempotencyKey: "writer-attempt", actorType: "test", leaseOwner: "worker",
    leaseToken: "00000000-0000-4000-8000-000000000018", leaseSeconds: 20,
  });
  await store.updateAttemptWorktree(claim.attempt.id, {
    baseCommit: "base", headCommit: "head", path: "/tmp/worktree", repositoryPath: "/tmp/repo",
    owner: "worker", status: "captured", changedFiles: ["a.txt"], diff: "diff --git a/a.txt b/a.txt",
  });
  const persisted = (await store.listAttempts(task.id))[0];
  assert.equal(persisted.worktree_base_commit, "base");
  assert.deepEqual(persisted.worktree_changed_files, ["a.txt"]);
  assert.match(persisted.worktree_diff ?? "", /a\.txt/);
  await store.finishTaskClaim({
    taskId: task.id, attemptId: claim.attempt.id, leaseOwner: "worker",
    leaseToken: "00000000-0000-4000-8000-000000000018", taskStatus: "failed", attemptStatus: "failed",
    terminalReason: "injected_failure", actorType: "test",
  });
  assert.deepEqual((await store.listAbandonedWorktrees()).map((attempt) => attempt.id), [claim.attempt.id]);
  await store.updateAttemptWorktree(claim.attempt.id, { cleanedAt: new Date().toISOString() });
  assert.deepEqual(await store.listAbandonedWorktrees(), []);
  await pg.close();
});
