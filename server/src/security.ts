import type { Context, Next } from "hono";
import { config } from "./config.js";

interface FailureBucket { failures: number; windowStartedAt: number; blockedUntil: number }

export class LoginThrottle {
  private readonly buckets = new Map<string, FailureBucket>();
  constructor(private readonly maxFailures: number, private readonly windowMs: number,
    private readonly blockMs: number, private readonly now: () => number = Date.now) {}
  retryAfterSeconds(key: string): number {
    const bucket = this.buckets.get(key);
    const remaining = bucket ? bucket.blockedUntil - this.now() : 0;
    return remaining > 0 ? Math.ceil(remaining / 1_000) : 0;
  }
  recordFailure(key: string): number {
    const now = this.now();
    const previous = this.buckets.get(key);
    const bucket = !previous || now - previous.windowStartedAt >= this.windowMs
      ? { failures: 0, windowStartedAt: now, blockedUntil: 0 } : previous;
    bucket.failures += 1;
    if (bucket.failures >= this.maxFailures) bucket.blockedUntil = now + this.blockMs;
    this.buckets.set(key, bucket);
    return this.retryAfterSeconds(key);
  }
  clear(key: string): void { this.buckets.delete(key); }
}

export const loginThrottle = new LoginThrottle(config.loginMaxFailures, config.loginWindowMs, config.loginBlockMs);
export function loginClientKey(c: Context): string {
  return config.trustProxy
    ? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "trusted-proxy-unknown"
    : "direct-client";
}
export function sameOriginAllowed(requestUrl: string, origin?: string, secFetchSite?: string): boolean {
  if (!origin) return !secFetchSite || secFetchSite === "same-origin" || secFetchSite === "none";
  try { return new URL(origin).origin === new URL(requestUrl).origin; } catch { return false; }
}
export async function requireSameOrigin(c: Context, next: Next) {
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
  if (!sameOriginAllowed(c.req.url, c.req.header("origin"), c.req.header("sec-fetch-site")))
    return c.json({ error: "cross-origin request rejected" }, 403);
  return next();
}
export async function securityHeaders(c: Context, next: Next) {
  await next();
  c.header("X-Content-Type-Options", "nosniff"); c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  c.header("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'");
  if (config.isProd) c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
}
export function deploymentBoundary() {
  const localOnly = ["127.0.0.1", "localhost", "::1"].includes(config.bindHost);
  const warnings = [...(!localOnly ? ["server is bound beyond loopback"] : []),
    ...(config.jwtSecret === "please-change-me-to-a-long-random-string" ? ["JWT_SECRET uses the development fallback"] : []),
    ...(config.dangerousMode ? ["dangerous execution mode is active"] : [])];
  return { mode: localOnly ? "local_only" as const : "network_exposed" as const,
    safeLocalOnly: localOnly && warnings.length === 0, bindHost: config.bindHost,
    dangerousMode: config.dangerousMode, warnings };
}
