# Public roadmap

Orce ships reliability before feature breadth. Dates are directional and scope may change as fault-test evidence arrives.

## Phase 0 — Baseline and scope lock

- Product brief, lifecycle invariants, 90-day non-goals, public baseline
- Owned failure/recovery matrix
- Local-only activation and outcome diagnostic export
- Security, contribution, issue/PR, release, and demo surfaces

## Phase 1 — Trustworthy engine

- Durable run/task/attempt state machine and atomic claim leases
- Idempotent start, retry, resume, and cancel; startup recovery
- Strict graph validation and deadlock termination
- Git worktree isolation, diff artifacts, conflict-safe integration
- Budget reservations, usage reconciliation, and bounded overshoot
- Safe defaults, login hardening, fault injection, and recovery E2E tests

Exit evidence: zero duplicates in 100 restart/reconnect repetitions, every invalid graph terminal, recovery within 30 seconds, preserved parallel diffs, and measured budget overshoot.

## Phase 2 — Operator-first workflow

- Attention-first home screen and unified run workspace
- Editable pre-run plan and dependency graph
- Retry/resume/rerun/skip/cancel with safe explanations
- Accessible, responsive UI and errors that never collapse into empty state

## Phase 3 — Provider-neutral adapters

- Versioned agent adapter and event contracts
- Claude Code, Codex/OpenAI, and generic process/HTTP adapters
- Scoped credentials, health checks, and conformance/recovery tests

## Phase 4 — Evidence-backed OSS launch

- Signed release aligned with npm and reproducible container
- Read-only demo, sample project, and end-to-end recipes
- Public reliability benchmark and ten external design partners

## Not in the next 90 days

Multi-company management, org charts, enterprise SSO/RBAC, plugin marketplace, autonomous company operation, general project-management replacement, and parity with broad control planes. See the [product brief](docs/product-brief.md).
