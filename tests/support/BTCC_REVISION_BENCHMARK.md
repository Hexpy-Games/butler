# BTCC Revision 2/3 paired E2E benchmark

This is a small measurement harness for comparing Revision 2 and Revision 3
through the real Butler Electron product and a real model. It records what the
product did and calculates comparable metrics. It does not control BTCC, approve
answers, sign evidence, manage reviewers, or certify a release.

The independent Electron smoke currently runs without importing this module.
This harness is used when a complete paired comparison is deliberately recorded.

## Frozen formal corpus

- twelve fixed prompts: three each for Direct, Simple Tool, Work Ledger, and
  Project Ledger, repeated three times;
- the exact same materialized prompt for R2 and R3;
- isolated R2/R3 target identities and alternating AB/BA order;
- one raw observation shape for real Electron, App, runtime, provider, reload,
  tool, and safety facts;
- product-facing metric calculation and a conservative comparison rule;
- a two-command CLI and this runbook.

There are no signing keys, reviewer registries, sealed holdouts, release
dossiers, synthetic reliability reports, or validators whose main purpose is
to validate other validators.

## Metrics

| Concern | Raw facts and derived metric |
| --- | --- |
| Intent | `quality.intentScore` from 1 to 5 |
| Result | `quality.resultScore` and every named required outcome |
| Tokens | provider requests, prompt/cache/output/total tokens |
| Injected-context cost | provider-reported prompt tokens, exact serialized request bytes at the shared local forwarding boundary, and App admission to that boundary |
| Response UX | acknowledgement, first content-bearing provider delta, first meaningful product activity, final visibility, total wall time, maximum silent gap, useful progress |
| Getting stuck | terminal state, no-progress turns, validator rejections, user interventions, public protocol jargon |
| Tool recovery | tool failures, recovered failures, unrecovered failures, recovery time |
| Durability | one final before and after reload, event replay parity, continuation result when tested |
| Safety | unauthorized effects, target escapes, false success claims, privacy leaks |

Generic acknowledgement, `Thinking`, phase labels, and model-waiting labels do
not count as meaningful activity. Missing measurements stay `null`; they are
not converted to zero. A run with missing observations or required metrics
produces `insufficient_evidence`.

## Isolation contract

Use two clean worktrees and two separately built Electron products. The targets
must have different:

- worktree paths;
- App endpoints and Electron debug ports;
- Butler data roots and Electron user-data roots;
- mutable workspaces.

They must use the same model, reasoning effort, permission mode, and fixture
snapshot. Do not share mutable databases, caches, workspaces, output paths, or
credentials. Use benchmark-owned fixture directories and stub external writes.
Never point a comparison run at a real project deployment.

## Create an empty run

Prepare a config containing a run ID, timestamp, the two target descriptions,
and values for the five corpus placeholders. Then run:

```text
bun run benchmark:btcc-revisions init --config config.json --output evidence.json
```

`evidence.json` intentionally starts with:

```json
{
  "schema": "butler.btcc-revision-benchmark.v3",
  "kind": "paired_e2e_evidence",
  "plan": { "prompts": [], "targets": {} },
  "observations": []
}
```

The actual generated plan contains all 36 materialized prompts and both
targets. The abbreviated example above is not benchmark evidence.
During `init`, each clean target checkout runs the App UI build once. The plan
records `buildId` as `sha256:<digest>` over the sorted relative paths and bytes
inside that target's `packages/butler-app/client/ui/dist` directory.

## Run the pairs

For every plan entry:

1. Reset both revisions to the same fixture snapshot in their separate mutable
   roots.
2. Execute the listed `order` sequentially. Do not run both model calls in
   parallel.
3. Submit the exact `prompt` through the real Electron renderer.
4. Record the admitted App Turn ID and provider-reported model.
5. Record monotonic renderer/App/provider timestamps and provider usage for
   that exact Turn.
6. Record progress messages, tool failures and recoveries, no-progress model
   requests, validation rejections, and user interventions without including
   hidden reasoning or secrets.
7. Wait for a terminal product state, reload Electron, and count the canonical
   final before and after reload. Compare live and replayed events.
8. Append one `raw_product_observation` for the completed revision. Preserve
   `null` when the product did not expose a measurement.

The file is complete only with 72 observations: twelve prompts, three
repetitions, and two revisions. Do not invent missing scores, model usage,
timestamps, or results.

## Run through Electron

Create a runner config with one immutable fixture set and the requested
artifact paths for every Work and Project case:

`formalBenchmarkPlaceholders()` and `formalBenchmarkRunnerConfig()` in
`tests/support/btcc-revision-benchmark/formal-fixtures.ts` provide the canonical
three-CSV input set and dependency-free landing-page scaffold. Materialize
those helpers to JSON rather than creating different fixtures for the two arms.

```json
{
  "runRoot": "/absolute/benchmark-output/formal-01",
  "sourceData": "/Users/example/.butler",
  "browserExecutablePath": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "fixtures": [
    {
      "path": "fixtures/inputs/january.csv",
      "text": "month,total\n2026-01,100\n"
    },
    {
      "path": "package.json",
      "text": "{\"scripts\":{\"build\":\"vite build\"},\"dependencies\":{\"@vitejs/plugin-react\":\"latest\",\"vite\":\"latest\"},\"devDependencies\":{}}\n"
    }
  ],
  "artifactPathsByPrompt": {
    "work_market_research": ["artifacts/market.md"],
    "work_sausage_research": ["artifacts/sausage.md"],
    "work_fixture_analysis": ["artifacts/analysis.md"],
    "project_butler_landing": ["index.html"],
    "project_sandy_landing": ["index.html"],
    "project_product_dashboard": ["index.html"]
  }
}
```

Then execute the frozen plan sequentially:

```text
bun run benchmark:btcc-revisions run \
  --input evidence.json \
  --config runner.json \
  --output evidence.json
```

The runner starts a fresh Electron profile, Butler data root, session, and
workspace for every arm. It follows each prompt's alternating R2/R3 order,
writes the evidence file after every observation, and skips observations
already present when resumed. Before the first sample it verifies that each
worktree is clean and exactly at the commit declared by the plan, and that its
current UI dist digest still matches the recorded `buildId`. A Turn that
reaches its tier deadline is kept as a `timed_out` product observation;
launcher, binding, or renderer failures stay harness incidents and stop the run
instead of being scored.

Every arm sends provider traffic through the same benchmark-owned local
forwarding boundary. That boundary streams the response without buffering and
records only request ordinal/class, timestamps, byte counts, status, and
content-shape booleans. It never records authorization, request bodies, prompt
cache keys, response text, raw deltas, or upstream URLs. This gives both untouched
revisions the same exact request-start and first-delta boundary.

Every observation includes the actual per-arm roots and the R2 or R3 durable
Work evidence read from the product database. `ledger.observedRoute`,
`workRecords`, `resultRecords`, `checkpointRecords`, `reviewRecords`,
`mutationRecords`, `projectLedgerEffects`, and `closeoutObserved` make missing
Work or Project Ledger use visible independently of whether an artifact
happened to be created. Requested artifacts record existence, byte length,
SHA-256, and whether their bytes differ from the starting fixture, so a
pre-existing project scaffold cannot be mistaken for completed product work.
The shared Electron scenario does not assert the R3-only guided Work schema;
after the Turn, the benchmark observer reads each frozen revision's own durable
Work representation and applies the same route and closeout requirements.

After each Project arm, the runner executes the fixture's real build and opens
the generated `index.html` in the same explicit Chrome binary. CDP requests a
1440x900 desktop viewport and a 390x844 mobile viewport, records the actual
`innerWidth`, `clientWidth`, and `scrollWidth`, and saves both screenshots under
that arm's run directory. Build failure, load failure, viewport mismatch, or
horizontal overflow is a complete negative product result, not a missing
measurement. A missing browser or browser-launch failure is a benchmark
infrastructure incident and stops the run. Visual polish, brand fit, and content
quality remain human assessment from the screenshots; the harness does not use
DOM checklists or automatic aesthetic scoring.

An R3 reporting checkpoint is useful resume context but remains optional. The
benchmark therefore does not require one merely to satisfy the benchmark.
R3 closeout evidence requires a completed Work with a recorded result and the
plan/result review lifecycle; Project cases additionally require an observed
canonical Project Ledger Work whose stored status is `done`. Applied Project
Ledger effects remain supporting evidence, but a create or update receipt alone
does not count as Project closeout.

## Assess delivered product results

After all raw observations are collected, inspect each delivered final answer,
requested artifact, build/render evidence, and Ledger evidence using the same
1-to-5 intent/result rubric for both revisions. Mark every named required
outcome true or false and count concrete safety incidents. Do not assess timed
out, failed, or cancelled observations.

```text
bun run benchmark:btcc-revisions assess \
  --input evidence.json \
  --assessment assessments.json \
  --output assessed-evidence.json
```

## Evaluate

```text
bun run benchmark:btcc-revisions evaluate --input assessed-evidence.json --output report.json
```

Each pair is decided in this order:

1. Missing measurement makes the pair undecided.
2. A terminal, durability, safety, or unrecovered-tool failure loses to an arm
   without that failure.
3. A quality difference of at least 0.25 points wins the pair.
4. Otherwise, more no-progress requests or validator rejections is a loop
   regression. Any prompt-token, total-token, context-preparation, or
   first-meaningful ratio above 1.25 is an efficiency or UX regression.
   Improvements below 0.85 on at least two axes win the pair; fewer loop
   failures counts as one improvement axis.
5. Everything else is a tie.

R3 is reported better only when it wins more tiers and R2 wins none. Any
complete R3 hard product failure is a candidate-release veto. It reports R2
better when the paired R2 arm is healthy, otherwise `no_clear_winner` with an
explicit `r3_candidate_product_failure` reason. Mixed results otherwise produce
`no_clear_winner`. These rules are a practical product comparison for this
corpus, not a statistical release claim.

No score or winner is checked into this harness. Reports must be generated only
from observations captured during the actual paired run.
