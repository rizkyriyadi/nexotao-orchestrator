import { Hono } from "hono";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { activeCwd } from "../projects.js";

export const fsRoute = new Hono();

const HIDE_BROWSE = new Set(["node_modules", ".git", ".next", ".cache", ".DS_Store"]);

// Browse the host filesystem (absolute paths) to pick a project folder during
// onboarding. Single-user + authed; directories only, read-only.
fsRoute.get("/fs/browse", async (c) => {
  const q = c.req.query("path");
  const dir = q && isAbsolute(q) ? resolve(q) : homedir();
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !HIDE_BROWSE.has(e.name))
      .map((e) => ({ name: e.name, path: join(dir, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parent = dirname(dir);
    return c.json({ path: dir, parent: parent !== dir ? parent : null, home: homedir(), dirs });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "cannot read directory" }, 400);
  }
});

/**
 * Resolve a client-supplied relative path against the agent workspace, refusing
 * anything that escapes it (path traversal). Returns null if unsafe.
 */
function safeResolve(rel: string): string | null {
  const base = activeCwd();
  const target = resolve(base, rel || ".");
  const relFromBase = relative(base, target);
  if (relFromBase === "") return base;
  if (relFromBase.startsWith("..") || isAbsolute(relFromBase)) return null;
  return target;
}

const MAX_READ = 512 * 1024; // 512 KB
const HIDE = new Set([".DS_Store"]);

fsRoute.get("/fs/list", async (c) => {
  const rel = c.req.query("path") ?? "";
  const dir = safeResolve(rel);
  if (!dir) return c.json({ error: "invalid path" }, 400);

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const items = await Promise.all(
      entries
        .filter((e) => !HIDE.has(e.name))
        .map(async (e) => {
          const abs = join(dir, e.name);
          let size = 0;
          let mtime: string | null = null;
          try {
            const s = await stat(abs);
            size = s.size;
            mtime = s.mtime.toISOString();
          } catch {
            /* broken symlink etc. */
          }
          return {
            name: e.name,
            type: e.isDirectory() ? ("dir" as const) : ("file" as const),
            size,
            mtime,
          };
        })
    );
    items.sort((a, b) => (a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name)));
    return c.json({ path: relative(activeCwd(), dir), root: activeCwd(), items });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "read failed" }, 404);
  }
});

fsRoute.get("/fs/read", async (c) => {
  const rel = c.req.query("path") ?? "";
  const file = safeResolve(rel);
  if (!file) return c.json({ error: "invalid path" }, 400);

  try {
    const s = await stat(file);
    if (s.isDirectory()) return c.json({ error: "is a directory" }, 400);
    if (s.size > MAX_READ) {
      return c.json({ path: rel, size: s.size, truncated: true, content: "", note: "file too large to preview (>512 KB)" });
    }
    const buf = await readFile(file);
    if (buf.includes(0)) {
      return c.json({ path: rel, size: s.size, binary: true, content: "" });
    }
    return c.json({ path: rel, size: s.size, content: buf.toString("utf8") });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "read failed" }, 404);
  }
});
