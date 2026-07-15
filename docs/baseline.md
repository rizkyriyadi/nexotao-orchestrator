# Phase 0 public baseline

Measured on 2026-07-14 UTC at `main` commit `d835b61`. Public counters are snapshots, not active-user claims.

| Measure | Baseline | Evidence/interpretation |
|---|---:|---|
| npm downloads, 2026-07-07 through 2026-07-13 | 1,860 | npm downloads API; may include CI and repeated installs |
| GitHub stars / forks / open issues | 0 / 0 / 0 | GitHub repository API; repository was created 2026-07-13 |
| GitHub description / topics | empty / none | GitHub repository API; owner guidance is in `.github/REPOSITORY_METADATA.md` |
| Automated tests discovered | 0 | No test script or test files on the baseline commit |
| CI gates | build only | `.github/workflows/ci.yml` ran `npm ci` and `npm run build` |
| Fault-matrix rows automated | 0 of 7 | No process-kill, reconnect, DB fault, planner-invalid, timeout, budget, or write-conflict suite |
| Retrospective activation funnel | unavailable | No prior instrumentation; it would be misleading to infer active users from downloads |

## Phase 0 measurement changes

- Authenticated local-only export now covers install, onboarding, first plan, first successful run, seven-day return usage, and run outcomes.
- CI now runs the diagnostics aggregation/privacy tests before the existing build.
- The [failure matrix](failure-matrix.md) defines seven owned fault tests and exact recovery/terminal outcomes for Phase 1.

## How to refresh

1. Record the commit and UTC timestamp.
2. Run `npm test` and `npm run build`.
3. Query the public GitHub repository and npm downloads APIs; never equate downloads with activated users.
4. Compare only voluntarily shared, reviewed local diagnostic exports. Do not add automatic upload or identifiers.
