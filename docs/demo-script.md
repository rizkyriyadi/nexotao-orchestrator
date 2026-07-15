# 90-second demo script and asset checklist

## Script

**0–10s — Promise.** “Orce is a local-first coding-agent runner: review a plan, run parallel work, and see exactly how it ends.” Show the home screen and local URL.

**10–25s — Start safely.** Create/import the sample project, show provider preflight, and point out that plan review is enabled. Never show a real key or home-directory path.

**25–45s — Plan.** Enter the prepared sample goal: “Add input validation and focused tests to the sample API.” Show the task graph, dependencies, assigned agents, and budget before approval.

**45–65s — Execute.** Approve. Show two independent tasks running, structured progress, cost, and the browser reconnecting without stopping the run.

**65–80s — Outcome.** Open the completed run, task evidence, and file diff. Show a prepared failure card with an explicit recovery action; do not claim restart recovery until its fault test passes.

**80–90s — Trust.** Download the local diagnostic export and state: “Nothing is uploaded by Orce.” End on the public reliability roadmap and contribution link.

## Asset checklist

- Clean disposable sample repository and seed commit
- Local Orce install with fake project/user names
- Provider test credential stored off-screen; browser autofill and notifications disabled
- 1440×960 capture, readable UI scale, captions, and cursor highlight
- Prepared successful run and prepared failure state to avoid live-provider variance
- Sanitization pass for terminal history, paths, keys, prompts, source, browser tabs, and notifications
- Captions/transcript, 90-second MP4/WebM, poster image, and three stills (plan, parallel run, recovery)
- Claims checked against [invariants](invariants.md), [failure matrix](failure-matrix.md), and [baseline](baseline.md)

## Refresh the README stills

Start the web app, then run the deterministic, sanitized capture set against its URL:

```bash
npm run --workspace web dev -- --host 127.0.0.1
ORCE_CAPTURE_URL=http://127.0.0.1:5173 npm run capture:docs
```

The capture script replaces the README images in `docs/images/` with current UI renders. Its fixture data uses only fictional project names, paths, tasks, and provider outcomes.
