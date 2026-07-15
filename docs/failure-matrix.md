# Failure and recovery matrix

This is the Phase 0 test contract. “Planned test” names the automated case that must land with the owning Phase 1 component; it does not claim the current engine passes.

| Failure injection | Expected terminal or recovery outcome | Evidence required | Planned automated test | Owner |
|---|---|---|---|---|
| Kill the server during planning, claiming, provider execution, usage commit, and integration | On restart, resume only a provably resumable attempt; otherwise enter `needs_attention` within 30 seconds. Never start a second active attempt. | Durable attempt/lease/event timeline and provider request key | `fault/process-kill-each-transition` | Engine/state-machine maintainer |
| Disconnect, refresh, or reconnect two browsers during a live run | Execution continues once; each browser reconstructs the same durable state and receives no duplicate terminal event. | Run/attempt ids before and after reconnect | `e2e/browser-disconnect-reconnect` | Web/run-workspace maintainer |
| Drop DB connectivity before claim, after provider call, and during terminal commit | Retry DB operations with bounds. If provider completion is ambiguous, stop in `needs_attention`; do not replay the provider call automatically. | Transaction result, request key, reconciliation reason | `fault/db-disconnect-boundaries` | Storage/recovery maintainer |
| Planner returns malformed JSON, unknown agent, duplicate key, missing dependency, self-edge, cycle, or oversized graph | Retry invalid model output once with structured feedback, then end planning as `failed` with a validation diagnosis; scheduler never starts. | Validation code and offending field category, without prompt content | `integration/planner-invalid-matrix` | Planner/graph maintainer |
| Provider times out before acknowledgement, after acknowledgement, or mid-stream | Retry only when the adapter proves no completion; otherwise reconcile by logical request key or enter `needs_attention`. Charge actual usage at most once. | Logical request id, provider attempt ids, usage entries | `adapter/provider-timeout-boundaries` | Adapter and usage maintainer |
| Budget reservation would cross limit, or actual usage reaches limit with tasks in flight | Refuse new claims, cancel supported in-flight calls, reconcile reservations and actual usage, then end `stopped` with bounded documented overshoot. | Reservation/actual ledger and cancellation results | `integration/budget-hit-concurrency` | Budget/usage maintainer |
| Two isolated tasks edit the same file and both request integration | Preserve both worktree diffs. Integrate at most one automatically; mark the other `needs_attention` with conflict files and safe actions. | Base commit, diff artifact, integration attempt ids | `integration/parallel-write-conflict` | Worktree/integration maintainer |

## Pass criteria

- 100 repeated start, reconnect, and restart scenarios produce zero duplicate execution.
- All invalid or cyclic graphs become terminal with a visible diagnosis; no scheduler hang.
- Every injected process kill converges within 30 seconds of restart.
- Parallel writers preserve both diffs and never silently overwrite.
- Budget tests prove the maximum overshoot and that no new task starts after a failed reservation.
