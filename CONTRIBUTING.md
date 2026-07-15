# Contributing to Nexotao Orce

Thanks for your interest! This is a young project — issues, ideas, and PRs are all welcome.

## Development setup

Requires **Node.js 20+**.

```bash
npm install
npm run dev:server   # API on :8787 (reads server/.env)
npm run dev:web      # UI on :5173
```

Create `server/.env` from `server/.env.example` for local config (password, optional `DATABASE_URL`, etc.).

## Project layout

```
server/   Node + Hono API, Claude Agent SDK wrapper, Orce engine, store
web/      React + Vite + Tailwind UI
bin/      one-command launcher (nexotao-orce)
```

## Before opening a PR

- `npm test` passes.
- `npm run build` passes (typechecks web + server and builds both).
- Keep the code style consistent with the surrounding files.
- For UI work, include a screenshot in the PR.
- Describe what you changed and why. Small, focused PRs merge fastest.

## Reporting bugs / ideas

Open the matching issue form with a synthetic reproduction or bounded use case. For security concerns, do not open a public issue or hint at exploit details in its title; use the private process in [SECURITY.md](SECURITY.md).

All participants must follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

By contributing you agree your contributions are licensed under the project's [MIT License](LICENSE).
