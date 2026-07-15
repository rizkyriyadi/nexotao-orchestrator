# Durable lifecycle state machine

The database is the canonical source for run, task, and attempt state. The in-process run registry only carries live streams and cancellation signals; it cannot authorize a lifecycle change.

Ordinary transitions are compare-and-set updates against the previously read state. A duplicate transition, an illegal edge, a missing terminal reason, or a concurrent update returns a distinct actionable error. Explicit retry commands may reopen `failed` and `needs_attention` records; completed and stopped records remain closed.

## Transition table

| Entity | From | Legal next states |
|---|---|---|
| Run | `planning` | `awaiting_approval`, `failed`, `stopped`, `needs_attention` |
| Run | `awaiting_approval` | `running`, `failed`, `stopped`, `needs_attention` |
| Run | `running` | `completed`, `failed`, `stopped`, `needs_attention` |
| Run | `failed` | `running` (explicit retry only) |
| Run | `needs_attention` | `running` (explicit retry), `stopped` |
| Run | `completed`, `stopped` | none |
| Task | `pending` | `running`, `failed`, `skipped`, `needs_attention` |
| Task | `running` | `done`, `failed`, `needs_attention` |
| Task | `failed`, `skipped`, `needs_attention` | `pending` (as part of an atomic run retry) |
| Task | `done` | none |
| Attempt | `created` | `running`, `stopped` |
| Attempt | `running` | `completed`, `failed`, `stopped`, `needs_attention` |
| Attempt | `completed`, `failed`, `stopped`, `needs_attention` | none |

Entering a terminal state requires a non-empty machine-readable `terminal_reason`. `started_at` is set on the first transition to `running`; `terminal_at` is set on terminal entry and cleared only by an explicit retry. Each record also persists its idempotency key, last actor type/id, provider, and `updated_at`. Attempts additionally persist a monotonic per-task attempt number and provider request key.

## Claim, lease, and command boundary

- A single SQL statement locks the task row, expires the prior attempt when necessary, allocates the next attempt number, inserts the attempt, and records the task's active attempt, owner, token, heartbeat, and expiry.
- A partial unique index permits only one `created` or `running` attempt per task. A 20-second lease is renewed by the owning engine while provider work is active.
- Heartbeat and terminal writes require the exact task id, attempt id, engine owner, opaque lease token, unexpired deadline, and `running` state. A stale worker receives `stale_lease`; its output and cost are not committed.
- Start, retry, cancel, and resume commands are append-only rows keyed by `(run_id, action, idempotency_key)`. Replays return the winning durable state. Cancellation stops active attempts and closes unfinished tasks in the same statement; retry reopens only failed, skipped, or needs-attention tasks.
- The provider request key is derived from the durable execution command plus task id. After an ambiguous process loss, Orce does not silently issue a replacement provider request.

## Migration and restart contract

`orce_schema_migrations` records a version only after every idempotent statement in that version succeeds. A failure aborts startup with the migration version, name, and statement number; the failed version remains unapplied and is safe to retry after the database error is fixed.

Existing run and task rows are assigned deterministic `legacy:*` idempotency keys. Existing terminal rows receive a deterministic `legacy_<status>` terminal reason and terminal timestamp. A process restart reconstructs current lifecycle state from these rows; it never derives canonical state from the live-stream registry.

The recovery monitor runs every two seconds. A live worker renews a 20-second lease; an unleased or expired running task becomes `needs_attention` with an instruction to reconcile provider usage before retry. Runs with no ambiguous in-flight provider call resume from their persisted task states. Interrupted planning also becomes `needs_attention`; awaiting-approval and terminal runs remain unchanged.
