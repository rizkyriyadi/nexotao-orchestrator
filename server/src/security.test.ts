import assert from "node:assert/strict";
import test from "node:test";
import { SessionAuthority } from "./auth.js";
import { LoginThrottle, sameOriginAllowed } from "./security.js";

test("login abuse is throttled for the full block interval and clears after success", () => {
  let now = 1_000;
  const throttle = new LoginThrottle(3, 60_000, 30_000, () => now);
  assert.equal(throttle.recordFailure("client"), 0);
  assert.equal(throttle.recordFailure("client"), 0);
  assert.equal(throttle.recordFailure("client"), 30);
  now += 1_000;
  assert.equal(throttle.retryAfterSeconds("client"), 29);
  throttle.clear("client");
  assert.equal(throttle.retryAfterSeconds("client"), 0);
});

test("session expiry and persistent generation revocation invalidate issued JWTs", async () => {
  const values = new Map<string, string>();
  const settings = {
    async getSetting(key: string) { return values.get(key) ?? null; },
    async setSetting(key: string, value: string) { values.set(key, value); },
  };
  let now = Math.floor(Date.now() / 1_000);
  const authority = new SessionAuthority(settings, "test-secret-long-enough", 60, () => now);
  await authority.init();
  const revoked = await authority.issue();
  assert.equal(await authority.valid(revoked), true);
  await authority.revokeAll();
  assert.equal(await authority.valid(revoked), false);
  const expiring = await authority.issue();
  now += 61;
  assert.equal(await authority.valid(expiring), false);
  assert.equal(values.get("auth_session_version"), "2");
});

test("mutation origin checks reject cross-site browser requests", () => {
  assert.equal(sameOriginAllowed("https://orce.example/api/login", "https://orce.example", "same-origin"), true);
  assert.equal(sameOriginAllowed("https://orce.example/api/login", "https://evil.example", "cross-site"), false);
  assert.equal(sameOriginAllowed("https://orce.example/api/login", undefined, "cross-site"), false);
});
