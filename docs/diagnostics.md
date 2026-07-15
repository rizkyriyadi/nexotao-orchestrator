# Local diagnostic export

Orce does not send telemetry. An authenticated operator can explicitly download a local JSON report:

```text
GET /api/diagnostics/export
```

In a browser session, open the endpoint on the same Orce origin. The response is marked `no-store` and downloads as `nexotao-orce-diagnostics.json`.

## What it measures

- install: first start after this feature is installed; legacy installations use the earliest local project timestamp;
- onboarding: at least one local project;
- first plan: a run advanced beyond `planning`;
- first successful run: a run reached `completed`;
- return usage: local project/run activity at least seven days after the install timestamp;
- aggregate run outcome counts.

The timestamp source is included so legacy approximations are not confused with exact first-start data. In-memory mode reports `persistent: false`; those measurements reset with the process.

## Data excluded by construction

The aggregation boundary accepts only timestamps, run states, and counts. The export contains no prompt, message, task title, run goal, model output, file name, filesystem path, project name, user/account identifier, IP address, environment variable, credential, API key, or source content. A regression test injects sentinel secret/source values and proves they cannot enter the serialized report.

Sharing the file is always the operator's decision. Review it before attaching it to a public issue. For troubleshooting that needs private logs or artifacts, follow [SECURITY.md](../SECURITY.md) instead of expanding this export.
