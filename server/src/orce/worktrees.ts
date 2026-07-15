import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const gitIdentity = { ...process.env, GIT_AUTHOR_NAME: "Nexotao Orce", GIT_AUTHOR_EMAIL: "orce@nexotao.local", GIT_COMMITTER_NAME: "Nexotao Orce", GIT_COMMITTER_EMAIL: "orce@nexotao.local" };
const integrationQueues = new Map<string, Promise<void>>();

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await exec("git", args, { cwd, env: gitIdentity, maxBuffer: 8 * 1024 * 1024 });
  return result.stdout.trimEnd();
}

async function gitExit(cwd: string, args: string[]): Promise<number> {
  try { await git(cwd, args); return 0; } catch (error) {
    return typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 2;
  }
}

async function serialized<T>(key: string, action: () => Promise<T>): Promise<T> {
  const prior = integrationQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolveTurn) => (release = resolveTurn));
  const queued = prior.then(() => turn);
  integrationQueues.set(key, queued);
  await prior;
  try { return await action(); } finally {
    release();
    if (integrationQueues.get(key) === queued) integrationQueues.delete(key);
  }
}

function safeId(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("worktree id contains unsupported characters");
  return value;
}

export interface PreparedWorktree { repositoryRoot: string; path: string; baseCommit: string; owner: string }
export interface CapturedWorktree extends PreparedWorktree { headCommit: string; changedFiles: string[]; diff: string }
export type IntegrationResult = { integrated: true; commit: string } | { integrated: false; reason: string };

/** Git-backed isolation and deterministic, serialized integration for one project repository. */
export class GitWorktreeManager {
  constructor(private readonly projectPath: string) {}

  async prepare(attemptId: string, owner: string): Promise<PreparedWorktree> {
    const repositoryRoot = resolve(await git(this.projectPath, ["rev-parse", "--show-toplevel"]));
    const dirty = await git(repositoryRoot, ["status", "--porcelain", "--untracked-files=all"]);
    if (dirty) throw new Error("project repository has uncommitted changes; refusing to create an incomplete worktree snapshot");
    const baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
    const root = join(dirname(repositoryRoot), ".nexotao-orce-worktrees", basename(repositoryRoot));
    const path = join(root, safeId(attemptId));
    await mkdir(root, { recursive: true });
    if (existsSync(path)) throw new Error(`worktree path already exists: ${path}`);
    await git(repositoryRoot, ["worktree", "add", "--detach", path, baseCommit]);
    return { repositoryRoot, path, baseCommit, owner };
  }

  async capture(worktree: PreparedWorktree): Promise<CapturedWorktree> {
    if ((await gitExit(worktree.path, ["merge-base", "--is-ancestor", worktree.baseCommit, "HEAD"])) !== 0) {
      throw new Error("worktree history no longer descends from its recorded base commit");
    }
    await git(worktree.path, ["add", "-A"]);
    if ((await gitExit(worktree.path, ["diff", "--cached", "--quiet"])) !== 0) {
      await git(worktree.path, ["commit", "--no-gpg-sign", "-m", `orce: capture attempt ${basename(worktree.path)}`]);
    }
    const headCommit = await git(worktree.path, ["rev-parse", "HEAD"]);
    const names = await git(worktree.path, ["diff", "--name-only", "-z", worktree.baseCommit, headCommit]);
    const changedFiles = names ? names.split("\0").filter(Boolean).sort() : [];
    const diff = changedFiles.length ? await git(worktree.path, ["diff", "--binary", "--full-index", worktree.baseCommit, headCommit]) : "";
    return { ...worktree, headCommit, changedFiles, diff };
  }

  async integrate(worktree: CapturedWorktree): Promise<IntegrationResult> {
    return serialized(worktree.repositoryRoot, async () => {
      const targetHead = await git(worktree.repositoryRoot, ["rev-parse", "HEAD"]);
      if ((await gitExit(worktree.repositoryRoot, ["merge-base", "--is-ancestor", worktree.baseCommit, targetHead])) !== 0) {
        return { integrated: false, reason: "recorded base is not an ancestor of the integration target" };
      }
      const dirty = await git(worktree.repositoryRoot, ["status", "--porcelain", "--untracked-files=all"]);
      if (dirty) return { integrated: false, reason: "integration target has uncommitted changes" };
      const targetNames = await git(worktree.repositoryRoot, ["diff", "--name-only", "-z", worktree.baseCommit, targetHead]);
      const changedSinceBase = new Set(targetNames ? targetNames.split("\0").filter(Boolean) : []);
      const overlaps = worktree.changedFiles.filter((file) => changedSinceBase.has(file)).sort();
      if (overlaps.length) return { integrated: false, reason: `overlapping changes: ${overlaps.join(", ")}` };
      if (!worktree.changedFiles.length) return { integrated: true, commit: targetHead };
      const commits = (await git(worktree.path, ["rev-list", "--reverse", `${worktree.baseCommit}..${worktree.headCommit}`])).split("\n").filter(Boolean);
      try {
        for (const commit of commits) await git(worktree.repositoryRoot, ["cherry-pick", commit]);
      } catch (error) {
        await gitExit(worktree.repositoryRoot, ["cherry-pick", "--abort"]);
        const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
        return { integrated: false, reason: `git conflict: ${message}` };
      }
      return { integrated: true, commit: await git(worktree.repositoryRoot, ["rev-parse", "HEAD"]) };
    });
  }

  async cleanup(worktree: Pick<PreparedWorktree, "repositoryRoot" | "path">): Promise<void> {
    if (existsSync(worktree.path)) await git(worktree.repositoryRoot, ["worktree", "remove", "--force", worktree.path]);
    await git(worktree.repositoryRoot, ["worktree", "prune"]);
  }
}
