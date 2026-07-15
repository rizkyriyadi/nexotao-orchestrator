# Security and spending boundary

Orce is designed for one trusted operator on a machine they control. The tested default binds to `127.0.0.1`, uses `plan` permission mode, requires a 12-character password, throttles failed logins, expires sessions after 12 hours, checks browser mutation origins, and emits restrictive response headers. Diagnostics report `local_only` or `network_exposed` and list unsafe configuration reasons without exposing secrets.

Network exposure is outside the safe local-only boundary unless an operator supplies HTTPS, a unique long `JWT_SECRET`, a strong password, host firewalling, and a trusted reverse proxy. `TRUST_PROXY=true` is only safe when untrusted clients cannot bypass that proxy. Orce is not a multi-tenant authorization boundary.

`bypassPermissions` is dangerous because agents can execute arbitrary commands with the server account's privileges. It is never the default. Startup rejects it unless `DANGEROUS_MODE_ACKNOWLEDGEMENT=I_UNDERSTAND_ORCE_CAN_EXECUTE_ARBITRARY_COMMANDS` persists in configuration, and every authenticated UI session displays a warning banner while it is active.

## Budget invariant and bounded overshoot

Budget values are stored as integer micro-USD. Before a worker provider call, one atomic database statement locks the run, checks `spent + reserved + estimate <= limit`, appends an idempotent reservation ledger entry, and creates the attempt. Completion atomically releases that reservation, appends actual provider spend, and updates the run totals. A denied reservation creates no attempt and therefore no provider call.

Planner cost is appended once with a stable idempotency key. Actual task cost can exceed its estimate after a provider call has begun; maximum overshoot is bounded by the sum of `(actual - reservation)` for already-running tasks (at most four concurrent workers). Operators should set `ORCE_TASK_RESERVATION_USD` above observed high-percentile task cost. The stop policy prevents new starts and marks remaining tasks skipped; it does not kill already-running provider calls, avoiding ambiguous usage and partial writes.

Session revocation increments a persisted generation and immediately invalidates all previously issued cookies. Roll back this change by restoring the prior release and schema-compatible code; the additive budget tables/columns may remain. Stop rollout if reservation totals become negative, ledger sums disagree with run totals, or diagnostics claim `local_only` while bound beyond loopback.
