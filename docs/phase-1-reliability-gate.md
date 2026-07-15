# Orce Phase 1 reliability gate

Date: 2026-07-15

## Recommendation

The composed Phase 1 head is a release candidate for founder review. The local gate passes and no known Phase 1 P0 lifecycle defect remains open. Production merge or deployment is not authorized by this report.

## Tested system map

1. HTTP lifecycle commands in [`routes.ts`](../server/src/orce/routes.ts) assign stable idempotency keys.
2. [`engine.ts`](../server/src/orce/engine.ts) validates the DAG, claims work, fences leases, reserves budget, and routes writers into isolated Git worktrees.
3. [`store.ts`](../server/src/orce/store.ts) commits claims, state transitions, integer micro-USD ledger effects, and recovery classification atomically.
4. Additive schema versions 1–5 in [`migrations.ts`](../server/src/orce/migrations.ts) are applied and restart-tested against embedded PostgreSQL.
5. [`worktrees.ts`](../server/src/orce/worktrees.ts) serializes integration and rejects overlapping writes deterministically.
6. The customer surface maps durable and streamed recovery states through [`types.ts`](../web/src/types.ts), [`parts.ts`](../web/src/lib/parts.ts), and the Orce run/task views.

## Invariants proved by the gate

- A repeated start/reconnect/resume key creates one command, one live attempt, and one provider request identity.
- A task has at most one unexpired owner; a stale owner cannot heartbeat or commit.
- Run/task/attempt terminal transitions are append-only in audit meaning and require a terminal reason.
- Invalid, cyclic, dangling, oversized, overly deep, and deadlocked graphs terminate visibly; the scheduler never waits without an active promise.
- Budget values are integer micro-USD. Claim plus reservation is atomic under the run lock, and a denied reservation creates no attempt/provider call.
- Completed/cancelled attempts release reservations atomically. A provider timeout after dispatch enters `needs_attention` and retains its reservation until usage reconciliation, preventing an unsafe retry from hiding or duplicating spend.
- Potential writers use distinct real Git worktrees. Same-file races never overwrite, disjoint work is integrated serially, and cleanup state is persisted for restart recovery.
- Safe defaults remain review-first and read-only; dangerous mode requires persisted acknowledgement and remains visibly bannered. Authentication throttle, expiry, revocation, origin checks, and security headers are covered.

## Evidence

Environment: Linux x64, Node 22.23.1, npm lockfile clean install, PGlite embedded PostgreSQL, Playwright Chromium 149.0.7827.55.

| Gate | Command | Result |
| --- | --- | --- |
| Unit + embedded database faults | `npm test --workspace server` | 38/38 passed |
| Customer-state reducers | `npm run test:web` | 3/3 passed |
| Browser happy/recovery paths | `npm run test:e2e` | 2/2 passed |
| Production bundles/type checks | `npm run build` | server and web passed |
| Patch hygiene | `git diff --check` | passed |

The server suite includes 100-way repeated starts, 100 reconnect/resume cycles, 100 competing workers, killed-worker restart fencing, invalid DAG/fuzz cases, budget denial/reconciliation, provider-timeout ambiguity, parallel writer conflict, auth throttling, and dangerous-mode safeguards. Browser tests prove review-first completion and refresh reattachment into a visible reconciliation-required state.

## Known bounds and ranked residual risk

1. **Live PostgreSQL timing — medium impact / medium likelihood.** Transactions are real PostgreSQL semantics through PGlite, but not a remote Supabase/Neon connection. Owner: platform engineer. Action: run the same focused suite on a copied staging database before rollout.
2. **Live provider usage reconciliation — high impact / low likelihood after fail-closed change.** No paid provider call is made by CI. Ambiguous failures retain reservation and block safe progress, but an operator still needs provider usage evidence before retry. Owner: operator/platform engineer.
3. **Multi-process integration queue — high impact / low likelihood in the supported single-engine topology.** Git ref locks prevent corruption, but the integration queue is process-local. Owner: platform engineer. Action: add a durable repository integration lease before enabling multiple engine processes.
4. **Hosted CI availability — medium impact / observed repository condition.** Prior GitHub jobs failed before executing steps. The workflow now contains the complete gate, but a green hosted run still depends on repository CI infrastructure. Owner: repository administrator.

## Rollout and rollback

- Roll out first on a copied database and disposable Git project with one engine process.
- Stop on any duplicate active attempt, stale-owner commit, negative/unequal budget ledger total, unacknowledged dangerous mode, non-Git/dirty target, or recovery taking more than 30 seconds.
- Roll back the application commit/branch. Schema versions 3–5 are additive and may remain; do not destructively downgrade tables.
- Do not retry a `needs_attention` provider attempt until provider usage, gateway attempt identity, ledger entries, and customer-visible balance are reconciled.
