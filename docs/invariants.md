# Core lifecycle invariants

These contracts define the trustworthy engine. A feature is not complete if it weakens one of them. Current gaps are explicit in the [failure matrix](failure-matrix.md) and roadmap.

The enforced run/task/attempt transition table and persisted lifecycle fields are documented in the [durable lifecycle state machine](lifecycle-state-machine.md).

## Run and task state

1. **Durable source of truth.** Database state, not an in-process map or browser connection, determines the current run, task, and attempt state.
2. **Explicit transitions.** Every state change has one allowed predecessor set, a timestamp, an actor or command identifier, and a terminal reason when applicable.
3. **Terminal convergence.** A run ends as `completed`, `failed`, `stopped`, or `needs_attention`; it never remains indefinitely `planning`, `running`, or pending without an active lease or visible recovery action.
4. **Dependency safety.** A task starts only after all dependencies completed successfully. Invalid keys, cycles, self-dependencies, oversized graphs, and scheduler deadlocks terminate planning with a visible diagnosis.

## Idempotency and concurrency

5. **One active attempt.** At most one unexpired execution lease exists for a task. Claiming work is an atomic database transition.
6. **Command idempotency.** Start, retry, resume, and cancel use durable idempotency keys. Replaying the same command cannot create another attempt or repeat its side effects.
7. **Monotonic attempts.** Retry creates the next numbered attempt; completed attempt records and events are append-only.
8. **Fenced workers.** A worker whose lease expired cannot commit later state or integrate files after a newer attempt acquired the task.

## Files and parallel work

9. **Real isolation.** Every writing attempt records its base commit and runs in a dedicated git worktree. A directory named “isolated” is not sufficient.
10. **Controlled integration.** File changes become visible in the target branch only through an explicit integration step that records the diff and detects conflicts.
11. **No silent overwrite.** Conflicting parallel writers enter a terminal or `needs_attention` state with both diffs preserved; last-writer-wins is forbidden.

## Budget and provider effects

12. **Pre-launch budget gate.** The scheduler reserves an estimated allowance atomically before provider work starts. No new attempt starts when its reservation would exceed the run limit.
13. **Usage reconciliation.** Provider usage events are attributed once to a provider request and attempt. Reservations, estimates, actual usage, and adjustments remain distinguishable and auditable.
14. **Failover without duplicate effects.** A retry or provider failover has a stable logical request key and a distinct provider-attempt key. Ambiguous upstream completion stops for reconciliation rather than starting an untracked duplicate.
15. **Bounded overshoot.** In-flight overshoot has a measured maximum, is visible to the operator, and never masquerades as a strict hard stop.

## Recovery and observability

16. **Disconnect independence.** Closing or refreshing the browser never cancels or duplicates work. Reattachment reads durable state and may subscribe to live updates.
17. **Startup reconciliation.** On boot, every non-terminal record is matched to a valid lease and resumable provider operation, or moved within 30 seconds to a documented recovery state.
18. **Append-only evidence.** Structured lifecycle events record command, attempt, lease, provider request, usage, artifact, and terminal reason without secrets, prompts, or source content in diagnostic exports.
19. **Actionable failure.** Operator-visible errors name what failed, whether side effects may have occurred, and the one safe next action.

## Security and privacy

20. **Least privilege by default.** Plan/review and constrained tools are the defaults. Bypass mode requires explicit acknowledgement and remains visibly enabled.
21. **Secret boundaries.** Credentials never appear in events, diagnostic exports, source artifacts, URLs, or logs. Workers receive only credentials required for their adapter.
22. **Local-only diagnostics.** Orce sends no telemetry. The authenticated operator may explicitly export aggregate timestamps, counts, and states as documented in [diagnostics](diagnostics.md).
