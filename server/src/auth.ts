import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { sign, verify } from "hono/jwt";
import { scryptSync, randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import { config } from "./config.js";
import { projectStore } from "./projects.js";

const COOKIE = "cwc_session";
const PW_SETTING = "auth_password"; // stored as scrypt:<saltHex>:<hashHex>
const SESSION_VERSION_SETTING = "auth_session_version";

// Resolved at boot. Password comes from ONE of:
//  1. APP_PASSWORD env (explicit — Docker / power users). Plaintext compare.
//  2. A hash stored in the DB, set by the operator on first run in the UI.
// If neither is present the app is in "setup mode" and the first screen asks
// the operator to create a password (never printed to the terminal).
let envPassword: string | null = null;
let storedHash: string | null = null;

export interface AuthSettings {
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
}

export class SessionAuthority {
  private version = 1;
  constructor(private readonly settings: AuthSettings, private readonly secret: string,
    private readonly ttlSeconds: number, private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1_000)) {}
  async init(): Promise<void> {
    const stored = Number(await this.settings.getSetting(SESSION_VERSION_SETTING));
    this.version = Number.isSafeInteger(stored) && stored > 0 ? stored : 1;
    await this.settings.setSetting(SESSION_VERSION_SETTING, String(this.version));
  }
  async issue(): Promise<string> {
    return sign({ sub: "owner", sid: randomUUID(), sv: this.version,
      exp: this.nowSeconds() + this.ttlSeconds }, this.secret);
  }
  async valid(token: string): Promise<boolean> {
    try {
      const payload = await verify(token, this.secret, "HS256") as Record<string, unknown>;
      return payload.sub === "owner" && payload.sv === this.version &&
        typeof payload.exp === "number" && payload.exp > this.nowSeconds();
    } catch { return false; }
  }
  async revokeAll(): Promise<void> {
    this.version += 1;
    await this.settings.setSetting(SESSION_VERSION_SETTING, String(this.version));
  }
}

const sessionAuthority = new SessionAuthority(projectStore, config.jwtSecret, config.sessionTtlSeconds);

function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 64);
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

function verifyHash(pw: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split(":");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(pw, Buffer.from(saltHex, "hex"), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Load password state from env + DB. Honors NEXOTAO_RESET_PASSWORD to clear it. */
export async function initAuth() {
  await sessionAuthority.init();
  const env = process.env.APP_PASSWORD;
  envPassword = env && env !== "changeme" ? env : null;
  if (envPassword && envPassword.length < 12) throw new Error("APP_PASSWORD must be at least 12 characters");

  if (process.env.NEXOTAO_RESET_PASSWORD) {
    await projectStore.setSetting(PW_SETTING, "");
    storedHash = null;
    console.log("[auth] password reset — create a new one in the app");
    return;
  }

  storedHash = (await projectStore.getSetting(PW_SETTING)) || null;
  if (envPassword) console.log("[auth] password via APP_PASSWORD env");
  else if (storedHash) console.log("[auth] password configured");
  else console.log("[auth] first run — create your password in the app");
}

/** True when no password exists yet (show the create-password screen). */
export function needsPasswordSetup(): boolean {
  return !envPassword && !storedHash;
}

/** Set the initial password (first run only). Persists a hash in the DB. */
export async function setupPassword(pw: string): Promise<void> {
  if (!needsPasswordSetup()) throw new Error("password already set");
  if (!pw || pw.length < 12) throw new Error("password must be at least 12 characters");
  storedHash = hashPassword(pw);
  await projectStore.setSetting(PW_SETTING, storedHash);
}

export function checkPassword(password: string): boolean {
  if (envPassword) {
    const a = Buffer.from(password);
    const b = Buffer.from(envPassword);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  if (storedHash) return verifyHash(password, storedHash);
  return false;
}

export async function issueToken(): Promise<string> {
  return sessionAuthority.issue();
}

export function setAuthCookie(c: Context, token: string) {
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: config.isProd,
    path: "/",
    maxAge: config.sessionTtlSeconds,
  });
}

export function clearAuthCookie(c: Context) {
  deleteCookie(c, COOKIE, { path: "/" });
}

/** Middleware: reject requests without a valid session cookie. */
export async function requireAuth(c: Context, next: Next) {
  const token = getCookie(c, COOKIE);
  if (!token) return c.json({ error: "unauthorized" }, 401);
  if (!(await sessionAuthority.valid(token))) return c.json({ error: "unauthorized" }, 401);
  return next();
}

export async function revokeAllSessions(): Promise<void> { await sessionAuthority.revokeAll(); }
