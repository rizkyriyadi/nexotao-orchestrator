# Security policy

## Supported versions

Security fixes are provided for the latest published npm version. Older versions may be asked to upgrade before a report is investigated.

## Report a vulnerability privately

Use GitHub's **Security → Report a vulnerability** private advisory form for this repository. Do not open a public issue, discussion, or pull request with exploit details, credentials, private logs, customer data, or an unredacted diagnostic artifact.

Include the affected version/commit, impact, minimal reproduction, and whether you believe exploitation is active. Use synthetic data. Maintainers should acknowledge a complete report within three business days, provide a triage update within seven, and coordinate disclosure after a fix or mitigation is available. These are response targets, not bounty or embargo guarantees.

If private advisories are unavailable, use the **Private contact request** issue form without technical details. A maintainer will establish a private channel.

## Deployment boundary

Orce can run shell commands and edit files with the host user's permissions. It is designed for a trusted single operator on localhost or a private network. Do not expose the raw port to the internet. Use HTTPS, a firewall or private tunnel, a unique strong password, least-privilege tool modes, and a dedicated non-root host account. Never use a production credential in a demo or public reproduction.

## Diagnostic artifacts

The built-in [local diagnostic export](docs/diagnostics.md) excludes prompts, paths, source, and secrets by construction and is never uploaded automatically. Still review any artifact before sharing it. Raw logs, database files, worktrees, and screenshots are not covered by that guarantee.
