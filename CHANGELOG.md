# Changelog

All notable changes are recorded here. Versions follow semantic versioning where practical.

## Unreleased

### Added

- Product brief, core lifecycle invariants, 90-day non-goals, public roadmap, failure matrix, and baseline evidence
- Authenticated local-only diagnostic export for aggregate activation and run outcomes
- Diagnostics privacy/aggregation test in CI
- Security policy, issue forms, pull-request template, release process, and demo checklist

### Known limitations

- Run execution is not yet durable across a full server restart.
- Start/retry leases, strict DAG validation, real git-worktree integration, and pre-launch budget reservation are Phase 1 work.
- Existing installations have only an approximate install timestamp based on their earliest local project.

## 0.2.13 — 2026-07-14

- Added image attachments to chat and agents.
- Baseline package used for the Phase 0 reliability audit.

Release owners should copy the relevant version section into GitHub Releases, attach checksums for distributed artifacts, and keep the npm version, git tag, and release title aligned.
