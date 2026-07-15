# Nexotao Orce product brief

## Product

Orce is a local-first, provider-agnostic agent runner for a solo developer or small technical team running two to eight coding agents from a laptop or private VM. The operator reviews a plan, sees dependencies and cost, and can understand and recover every run after a browser or server restart.

**Promise:** install in under ten minutes, connect a supported provider, run multi-agent coding work safely, and always know what happened and what to do next.

## Problem and wedge

Terminal agents are effective but difficult to coordinate across parallel work, remote devices, failures, and budgets. General company-control-plane products add roles and governance before the local execution lifecycle is trustworthy. Orce takes the narrower wedge: single-operator, coding-first orchestration with explicit plans, bounded concurrency, visible outcomes, and durable recovery.

## Primary journey

1. Install locally and create the owner password.
2. Create or import a project and pass provider preflight.
3. Describe an outcome and review a validated task graph.
4. Approve execution; inspect task state, output, file changes, and cost.
5. Recover, retry, or stop with an explicit terminal reason.

## Product principles

- Reliability is a feature: lifecycle claims require fault tests.
- Review is the safe default; dangerous execution requires explicit acknowledgement.
- Local data stays local. Diagnostics are generated on demand and never uploaded by Orce.
- Provider and worker behavior sit behind a small adapter contract.
- Every failure must become terminal or present one actionable recovery step.

## 90-day success measures

| Dimension | Target |
|---|---|
| Activation | Median install to first successful run under 10 minutes; at least 60% completion among measured local exports |
| Reliability | At least 99% terminal or explicitly recoverable outcomes in the fault suite; zero duplicate execution |
| Recovery | Orphan diagnosis or recovery within 30 seconds after restart |
| Safety | Dangerous mode always acknowledged and visible; never the default |
| Portability | One conformance workflow passes on Claude Code, Codex/OpenAI, and generic process/HTTP adapters |
| Community | 10 activated design partners and three meaningful external contributions or resolved reports |

## Non-goals through October 2026

- Multi-company portfolio management
- Full org-chart or HR metaphors
- Enterprise SSO or granular RBAC
- Plugin marketplace
- Autonomous 24/7 company operation
- General-purpose project management replacement

These are scope constraints, not promises for the following quarter. See [ROADMAP.md](../ROADMAP.md) and [core invariants](invariants.md).
