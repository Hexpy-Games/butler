# BTCC R3 real Electron E2E driver

This driver launches the real Butler Electron application with a fresh App
database, Electron profile, and fixture workspace. Prompts are submitted through
the visible composer. The resulting Turn is observed through the renderer's
normal preload bridge and checked again after a renderer reload or full Electron
restart.

It does not construct an in-process BTCC runtime or use a synthetic model. The
source Butler data directory is read only: the driver copies only the selected
configuration and provider credential files into the isolated run directory.
Credential values are never included in evidence or console output.

## Preflight and launch smoke

```sh
bun run tests/e2e/btcc-r3-electron-driver.ts \
  --dry-run \
  --scenario /absolute/path/to/scenario.json

bun run tests/e2e/btcc-r3-electron-driver.ts \
  --smoke \
  --run-root /absolute/path/to/a/new/run-directory
```

The smoke launches Electron twice and verifies that the explicit fixture-bound
session survives a full application restart. It starts the production native
executor required by the App, but sends no provider request.

## Isolated real-model Work scenario

The checked-in scenario exercises a substantial local Work request, verifies
the artifact, reloads the renderer, restarts Electron, and checks the persisted
final response again:

```sh
bun run e2e:btcc-r3:electron -- \
  --scenario tests/e2e/btcc-r3-electron-work-scenario.json \
  --run-root /absolute/path/to/a/new/run-directory \
  --model openai/gpt-5.6-sol \
  --reasoning low \
  --keep-logs
```

For the complete R3-02 exit path (direct/no Work, multi-source read-only Work,
artifact Work, and fresh-Turn continuation of the same Work after restart), use
`tests/e2e/btcc-r3-electron-exit-scenario.json` with the same command.

## Isolated project-session effect scenario

`tests/e2e/btcc-r3-electron-project-effect-scenario.json` creates a scratch
project and a project chat through the real Electron preload bridge. The App
chooses and persists the scratch workspace; the harness verifies that it is
inside the isolated run data before binding the runtime session to it.

The first Turn creates one reviewed `project_ledger_create` effect and checks
that its tool result is attached to durable Work. After a full Electron restart,
the second Turn uses a native Project Ledger read to confirm the persisted
marker:

```sh
bun run e2e:btcc-r3:electron -- \
  --scenario tests/e2e/btcc-r3-electron-project-effect-scenario.json \
  --run-root /absolute/path/to/a/new/run-directory \
  --model openai/gpt-5.6-sol \
  --reasoning low \
  --keep-logs
```

To verify only project/session creation and restart without sending a provider
request, add `--smoke`.

## Scenario format

```json
{
  "schema": "butler.btcc-r3-electron-scenario.v1",
  "id": "durable-work-continuation",
  "model": "openai/gpt-5.6-sol",
  "reasoningEffort": "low",
  "accessMode": "full_access",
  "session": {
    "id": "durable-work-continuation",
    "kind": "chat",
    "title": "BTCC R3 Durable Work continuation"
  },
  "fixtures": [
    { "path": "input/a.txt", "text": "alpha\n" },
    { "path": "input/b.txt", "text": "beta\n" }
  ],
  "steps": [
    {
      "id": "create-report",
      "prompt": "input의 두 파일을 확인해 report.md에 요약해 주세요.",
      "timeoutMs": 600000,
      "reloadAfter": true,
      "restartAfter": true,
      "expect": {
        "terminalState": "delivered",
        "files": [
          { "path": "report.md", "contains": ["alpha", "beta"] }
        ],
        "work": {
          "exists": true,
          "status": "completed",
          "planRevisionAtLeast": 1,
          "planReviewVerdict": "accept",
          "resultReviewVerdict": "accept",
          "resultToolNamesInclude": ["read_file", "write_file"]
        }
      }
    },
    {
      "id": "fresh-turn-continuation",
      "prompt": "앞선 작업을 이어서 report.md 끝에 검증 결과를 추가해 주세요.",
      "reloadAfter": true,
      "expect": {
        "terminalState": "delivered",
        "files": [
          { "path": "report.md", "contains": ["검증"] }
        ]
      }
    }
  ]
}
```

`{{WORKSPACE}}` and `{{DATA_ROOT}}` are the only prompt placeholders. Fixture and
expected file paths must be relative and may not escape the fixture workspace.
`session.kind` defaults to `chat`; use `project` with an optional
`projectDisplayName` to create an isolated scratch project through the App.
Every run root must be a new, previously nonexistent path; this avoids deleting
or overwriting user data. The final `evidence.json` records the actual model,
Turn IDs, renderer-visible final text and ordered activity blocks, timings,
reload/restart parity, expected artifacts, screenshots, and the effective
runtime workspace binding. For every
Turn it also records the App database's Work id, status, current plan revision,
ordered checkpoint stages, latest checkpoint stage, plan/result Review verdicts,
completion Validation verdict, and attached result tool names. It deliberately
does not read or store raw tool result JSON.

If the production queue parks a Turn with its explicit process-replacement
marker, the harness may replace its own isolated native executor once. The
launch evidence records this as `interruptedExecutorReplaced`; any second
replacement request fails the run instead of becoming a test-side supervisor.

`expect.work` is optional. When present, Work existence is required unless
`exists` is `false`. `sameWorkAsStep` can assert that an unfinished Work record
continued into a later Turn; it must name an earlier step in the same scenario.
`checkpointStagesInclude` checks an ordered subsequence, so a Managed Work
scenario can prove distinct Review, Validation, and Reporting facts without
assuming an exact number of intermediate corrections.
`rendererActivityStagesInclude` applies the same ordered-subsequence check to
the activity blocks expanded and read from the real Electron renderer; each
captured block must also contain visible text.
