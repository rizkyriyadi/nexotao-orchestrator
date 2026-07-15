import { Hono } from "hono";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { orceStore } from "../orce/store.js";
import { projectStore, setActiveProject, getActiveProject, freshProjectPath, activeCwd } from "../projects.js";
import { ensureGraph, graphExists } from "../graph.js";
import { setApiKey, setProvider } from "../ai.js";

export const projectsRoute = new Hono();

// Build/refresh the knowledge graph for the active project (blocks until done).
projectsRoute.post("/projects/build-graph", async (c) => {
  await ensureGraph(activeCwd());
  return c.json({ hasGraph: graphExists(activeCwd()) });
});

projectsRoute.get("/projects", async (c) => {
  const [list, active] = [await projectStore.list(), getActiveProject()];
  return c.json({ projects: list, activeId: active?.id ?? null });
});

projectsRoute.post("/projects", async (c) => {
  const body = await c.req.json<{
    name?: string;
    kind?: "fresh" | "imported";
    path?: string;
    agents?: "one" | "all";
    model?: string;
    apiKey?: string;
    provider?: "nexotao" | "claude";
  }>();
  const name = (body.name ?? "").trim();
  const kind = body.kind === "fresh" ? "fresh" : "imported";
  if (!name) return c.json({ error: "name required" }, 400);
  if (body.provider) await setProvider(body.provider);
  if (body.apiKey && body.apiKey.trim()) await setApiKey(body.apiKey.trim());

  let path: string;
  if (kind === "fresh") {
    path = freshProjectPath(name);
  } else {
    const p = resolve((body.path ?? "").trim());
    if (!body.path || !existsSync(p) || !statSync(p).isDirectory()) {
      return c.json({ error: "path does not exist or is not a directory" }, 400);
    }
    path = p;
  }

  const project = await projectStore.create(name, path, kind, body.model?.trim() || null);
  await setActiveProject(project.id);
  // Fresh → one Generalist; imported → the full builtin team (unless overridden).
  const which = body.agents ?? (kind === "fresh" ? "one" : "all");
  await orceStore.seedBuiltins(project.id, which);

  return c.json(project);
});

projectsRoute.post("/projects/:id/activate", async (c) => {
  const p = await setActiveProject(c.req.param("id"));
  if (!p) return c.json({ error: "not found" }, 404);
  return c.json(p);
});

projectsRoute.delete("/projects/:id", async (c) => {
  const id = c.req.param("id");
  await projectStore.remove(id);
  // If the active project was deleted, fall back to the most recent remaining one.
  if (getActiveProject()?.id === id) {
    const list = await projectStore.list();
    if (list[0]) await setActiveProject(list[0].id);
  }
  return c.json({ ok: true });
});
