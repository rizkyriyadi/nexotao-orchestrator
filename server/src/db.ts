import { randomUUID } from "node:crypto";
import { sql as dbSql, dbMode, dbLabel } from "./driver.js";

export interface Session {
  id: string;
  project_id: string | null;
  title: string;
  sdk_session_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: unknown; // structured blocks (text + tool events)
  created_at: string;
}

export interface Store {
  init(): Promise<void>;
  createSession(projectId: string | null, title: string): Promise<Session>;
  listSessions(projectId: string | null): Promise<Session[]>;
  getSession(id: string): Promise<Session | null>;
  updateSession(id: string, patch: Partial<Pick<Session, "title" | "sdk_session_id">>): Promise<void>;
  deleteSession(id: string): Promise<void>;
  addMessage(sessionId: string, role: Message["role"], content: unknown): Promise<Message>;
  listMessages(sessionId: string): Promise<Message[]>;
  counts(projectId: string | null): Promise<{ sessions: number; messages: number; lastActivityAt: string | null }>;
}

/* ------------------------------------------------------------------ */
/* Neon / Postgres store                                              */
/* ------------------------------------------------------------------ */

class SqlStore implements Store {
  private sql = dbSql;

  async init() {
    await this.sql`
      CREATE TABLE IF NOT EXISTS sessions (
        id UUID PRIMARY KEY,
        title TEXT NOT NULL,
        sdk_session_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
    await this.sql`
      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY,
        session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
    await this.sql`CREATE INDEX IF NOT EXISTS messages_session_idx ON messages(session_id)`;
  }

  async createSession(projectId: string | null, title: string): Promise<Session> {
    const id = randomUUID();
    const rows = (await this.sql`
      INSERT INTO sessions (id, project_id, title) VALUES (${id}, ${projectId}, ${title})
      RETURNING *`) as Session[];
    return rows[0];
  }

  async listSessions(projectId: string | null): Promise<Session[]> {
    return (await this.sql`
      SELECT * FROM sessions WHERE project_id = ${projectId} ORDER BY updated_at DESC`) as Session[];
  }

  async getSession(id: string): Promise<Session | null> {
    const rows = (await this.sql`SELECT * FROM sessions WHERE id = ${id}`) as Session[];
    return rows[0] ?? null;
  }

  async updateSession(id: string, patch: Partial<Pick<Session, "title" | "sdk_session_id">>) {
    if (patch.title !== undefined) {
      await this.sql`UPDATE sessions SET title = ${patch.title}, updated_at = now() WHERE id = ${id}`;
    }
    if (patch.sdk_session_id !== undefined) {
      await this.sql`UPDATE sessions SET sdk_session_id = ${patch.sdk_session_id}, updated_at = now() WHERE id = ${id}`;
    }
  }

  async deleteSession(id: string) {
    await this.sql`DELETE FROM sessions WHERE id = ${id}`;
  }

  async addMessage(sessionId: string, role: Message["role"], content: unknown): Promise<Message> {
    const id = randomUUID();
    const rows = (await this.sql`
      INSERT INTO messages (id, session_id, role, content)
      VALUES (${id}, ${sessionId}, ${role}, ${JSON.stringify(content)})
      RETURNING *`) as Message[];
    await this.sql`UPDATE sessions SET updated_at = now() WHERE id = ${sessionId}`;
    return rows[0];
  }

  async listMessages(sessionId: string): Promise<Message[]> {
    return (await this.sql`
      SELECT * FROM messages WHERE session_id = ${sessionId} ORDER BY created_at ASC`) as Message[];
  }

  async counts(projectId: string | null) {
    const rows = (await this.sql`
      SELECT
        (SELECT count(*) FROM sessions WHERE project_id = ${projectId})::int AS sessions,
        (SELECT count(*) FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ${projectId}))::int AS messages,
        (SELECT max(updated_at) FROM sessions WHERE project_id = ${projectId}) AS last`) as {
      sessions: number;
      messages: number;
      last: string | null;
    }[];
    const r = rows[0];
    return { sessions: r.sessions, messages: r.messages, lastActivityAt: r.last };
  }
}

/* ------------------------------------------------------------------ */
/* In-memory fallback (history lost on restart)                       */
/* ------------------------------------------------------------------ */

class MemoryStore implements Store {
  private sessions = new Map<string, Session>();
  private messages = new Map<string, Message[]>();

  async init() {}

  private now() {
    return new Date().toISOString();
  }

  async createSession(projectId: string | null, title: string): Promise<Session> {
    const now = this.now();
    const s: Session = { id: randomUUID(), project_id: projectId, title, sdk_session_id: null, created_at: now, updated_at: now };
    this.sessions.set(s.id, s);
    this.messages.set(s.id, []);
    return s;
  }

  async listSessions(projectId: string | null): Promise<Session[]> {
    return [...this.sessions.values()]
      .filter((s) => s.project_id === projectId)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async getSession(id: string): Promise<Session | null> {
    return this.sessions.get(id) ?? null;
  }

  async updateSession(id: string, patch: Partial<Pick<Session, "title" | "sdk_session_id">>) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (patch.title !== undefined) s.title = patch.title;
    if (patch.sdk_session_id !== undefined) s.sdk_session_id = patch.sdk_session_id;
    s.updated_at = this.now();
  }

  async deleteSession(id: string) {
    this.sessions.delete(id);
    this.messages.delete(id);
  }

  async addMessage(sessionId: string, role: Message["role"], content: unknown): Promise<Message> {
    const m: Message = {
      id: randomUUID(),
      session_id: sessionId,
      role,
      content,
      created_at: this.now(),
    };
    this.messages.get(sessionId)?.push(m);
    const s = this.sessions.get(sessionId);
    if (s) s.updated_at = this.now();
    return m;
  }

  async listMessages(sessionId: string): Promise<Message[]> {
    return this.messages.get(sessionId) ?? [];
  }

  async counts(projectId: string | null) {
    const sess = [...this.sessions.values()].filter((s) => s.project_id === projectId);
    let messages = 0;
    for (const s of sess) messages += this.messages.get(s.id)?.length ?? 0;
    const last = sess.reduce<string | null>((acc, s) => (!acc || s.updated_at > acc ? s.updated_at : acc), null);
    return { sessions: sess.length, messages, lastActivityAt: last };
  }
}

export let store: Store;

export async function initStore() {
  store = dbMode() === "memory" ? new MemoryStore() : new SqlStore();
  await store.init();
  console.log(`[db] storage: ${dbLabel()}`);
}
