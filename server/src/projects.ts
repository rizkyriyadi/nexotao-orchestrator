import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "./config.js";
import { sql as dbSql, dbMode } from "./driver.js";

export interface Project {
  id: string;
  name: string;
  path: string;
  kind: "fresh" | "imported";
  model: string | null; // default AI model for this project's agents
  created_at: string;
  last_active_at: string;
}

export interface ProjectStore {
  init(): Promise<void>;
  list(): Promise<Project[]>;
  get(id: string): Promise<Project | null>;
  create(name: string, path: string, kind: Project["kind"], model: string | null): Promise<Project>;
  setModel(id: string, model: string | null): Promise<void>;
  remove(id: string): Promise<void>;
  touch(id: string): Promise<void>;
  getActiveId(): Promise<string | null>;
  setActiveId(id: string): Promise<void>;
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  /** For migration: backfill NULL project_id on legacy rows to `id`. */
  backfill(id: string): Promise<void>;
}

/* ------------------------------------------------------------------ */

class SqlProjectStore implements ProjectStore {
  private sql = dbSql;

  async init() {
    await this.sql`
      CREATE TABLE IF NOT EXISTS projects (
        id UUID PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'imported',
        model TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_active_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
    await this.sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS model TEXT`;
    await this.sql`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)`;
    // Add project_id to scoped tables (they're created before initProjects runs).
    await this.sql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS project_id UUID`;
    await this.sql`ALTER TABLE orce_agents ADD COLUMN IF NOT EXISTS project_id UUID`;
    await this.sql`ALTER TABLE orce_runs ADD COLUMN IF NOT EXISTS project_id UUID`;
  }

  async list() {
    return (await this.sql`SELECT * FROM projects ORDER BY last_active_at DESC`) as Project[];
  }
  async get(id: string) {
    const r = (await this.sql`SELECT * FROM projects WHERE id = ${id}`) as Project[];
    return r[0] ?? null;
  }
  async create(name: string, path: string, kind: Project["kind"], model: string | null) {
    const id = randomUUID();
    const r = (await this
      .sql`INSERT INTO projects (id, name, path, kind, model) VALUES (${id}, ${name}, ${path}, ${kind}, ${model}) RETURNING *`) as Project[];
    return r[0];
  }
  async setModel(id: string, model: string | null) {
    await this.sql`UPDATE projects SET model = ${model} WHERE id = ${id}`;
  }
  async remove(id: string) {
    await this.sql`DELETE FROM projects WHERE id = ${id}`;
  }
  async touch(id: string) {
    await this.sql`UPDATE projects SET last_active_at = now() WHERE id = ${id}`;
  }
  async getActiveId() {
    const r = (await this.sql`SELECT value FROM app_settings WHERE key = 'active_project_id'`) as { value: string }[];
    return r[0]?.value ?? null;
  }
  async setActiveId(id: string) {
    await this
      .sql`INSERT INTO app_settings (key, value) VALUES ('active_project_id', ${id}) ON CONFLICT (key) DO UPDATE SET value = ${id}`;
  }
  async getSetting(key: string) {
    const r = (await this.sql`SELECT value FROM app_settings WHERE key = ${key}`) as { value: string }[];
    return r[0]?.value ?? null;
  }
  async setSetting(key: string, value: string) {
    await this
      .sql`INSERT INTO app_settings (key, value) VALUES (${key}, ${value}) ON CONFLICT (key) DO UPDATE SET value = ${value}`;
  }
  async backfill(id: string) {
    await this.sql`UPDATE sessions SET project_id = ${id} WHERE project_id IS NULL`;
    await this.sql`UPDATE orce_agents SET project_id = ${id} WHERE project_id IS NULL`;
    await this.sql`UPDATE orce_runs SET project_id = ${id} WHERE project_id IS NULL`;
  }
}

/* ------------------------------------------------------------------ */

class MemoryProjectStore implements ProjectStore {
  private projects = new Map<string, Project>();
  private settings = new Map<string, string>();
  private activeId: string | null = null;
  private now() {
    return new Date().toISOString();
  }
  async init() {}
  async list() {
    return [...this.projects.values()].sort((a, b) => b.last_active_at.localeCompare(a.last_active_at));
  }
  async get(id: string) {
    return this.projects.get(id) ?? null;
  }
  async create(name: string, path: string, kind: Project["kind"], model: string | null) {
    const p: Project = { id: randomUUID(), name, path, kind, model, created_at: this.now(), last_active_at: this.now() };
    this.projects.set(p.id, p);
    return p;
  }
  async setModel(id: string, model: string | null) {
    const p = this.projects.get(id);
    if (p) p.model = model;
  }
  async remove(id: string) {
    this.projects.delete(id);
  }
  async touch(id: string) {
    const p = this.projects.get(id);
    if (p) p.last_active_at = this.now();
  }
  async getActiveId() {
    return this.activeId;
  }
  async setActiveId(id: string) {
    this.activeId = id;
  }
  async getSetting(key: string) {
    return this.settings.get(key) ?? null;
  }
  async setSetting(key: string, value: string) {
    this.settings.set(key, value);
  }
  async backfill() {}
}

export let projectStore: ProjectStore;

/* ------------------------------------------------------------------ */
/* Active-project cache (synchronous access for request hot paths)     */
/* ------------------------------------------------------------------ */

let active: Project | null = null;

/** The directory the agent works in for the active project (fallback: config.agentCwd). */
export function activeCwd(): string {
  return active?.path ?? config.agentCwd;
}
export function activeProjectId(): string | null {
  return active?.id ?? null;
}
export function getActiveProject(): Project | null {
  return active;
}

export async function setActiveProject(id: string): Promise<Project | null> {
  const p = await projectStore.get(id);
  if (!p) return null;
  active = p;
  await projectStore.setActiveId(id);
  await projectStore.touch(id);
  return p;
}

/** Ensure a fresh project's directory exists under the data dir. */
export function freshProjectPath(name: string): string {
  const dataDir = process.env.NEXOTAO_DATA || join(homedir(), ".nexotao-orce");
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  const dir = join(dataDir, "projects", slug);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function initProjects() {
  projectStore = dbMode() === "memory" ? new MemoryProjectStore() : new SqlProjectStore();
  await projectStore.init();
  const list = await projectStore.list();
  if (list.length === 0) {
    // Fresh install — no projects. The onboarding wizard handles the first one.
    active = null;
    console.log("[projects] none yet — onboarding");
    return;
  }
  const activeId = (await projectStore.getActiveId()) ?? list[0].id;
  active = (await projectStore.get(activeId)) ?? list[0];
  await projectStore.setActiveId(active.id);
  console.log(`[projects] active: ${active.name} (${active.path})`);
}
