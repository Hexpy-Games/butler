# BTCC Revision 2/3 paired E2E benchmark

This is a small measurement harness for comparing Revision 2 and Revision 3
through the real Butler Electron product and a real model. It records what the
product did and calculates comparable metrics. It does not control BTCC, approve
answers, sign evidence, manage reviewers, or certify a release.

The independent Electron smoke currently runs without importing this module.
This harness is used when a complete paired comparison is deliberately recorded.

## What remains

- eight fixed prompts: two each for Direct, Simple Tool, Work Ledger, and
  Project Ledger;
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
| Injected-context cost | serialized context bytes and App admission to first model-request time |
| Response UX | acknowledgement, first meaningful text, final visibility, total wall time, maximum silent gap, useful progress |
| Getting stuck | terminal state, no-progress turns, validator rejections, user interventions, public protocol jargon |
| Tool recovery | tool failures, recovered failures, unrecovered failures, recovery time |
| Durability | one final before and after reload, event replay parity, continuation result when tested |
| Safety | unauthorized effects, target escapes, false success claims, privacy leaks |

Missing measurements stay `null`; they are not converted to zero. A run with
missing observations or metrics produces `insufficient_evidence`.

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

The actual generated plan contains all eight materialized prompts and both
targets. The abbreviated example above is not benchmark evidence.

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
6. Record progress messages, tool failures and recoveries, no-progress turns,
   validation rejections, and user interventions without including hidden
   reasoning or secrets.
7. Wait for a terminal product state, reload Electron, and count the canonical
   final before and after reload. Compare live and replayed events.
8. Inspect the final answer and artifacts using the same 1-to-5 intent/result
   rubric for both revisions. Mark each required outcome true or false and add
   a short assessment note. This is ordinary benchmark scoring, not a signed
   reviewer protocol.
9. Append one `raw_product_observation` for the completed revision. Preserve
   `null` when the product did not expose a measurement.

The file is complete only with 16 observations: eight prompts times two
revisions. Do not invent missing scores, model usage, timestamps, or results.

## Evaluate

```text
bun run benchmark:btcc-revisions evaluate --input evidence.json --output report.json
```

Each pair is decided in this order:

1. Missing measurement makes the pair undecided.
2. A terminal, durability, safety, or unrecovered-tool failure loses to an arm
   without that failure.
3. A quality difference of at least 0.25 points wins the pair.
4. Otherwise, any token, context-preparation, or first-meaningful ratio above
   1.25 is a regression; improvements below 0.85 on at least two of those axes
   win the pair.
5. Everything else is a tie.

R3 is reported better only when it wins more tiers and R2 wins none. R2 uses
the symmetric rule. Mixed results produce `no_clear_winner`. These rules are a
practical product comparison for this corpus, not a statistical release claim.

No score or winner is checked into this harness. Reports must be generated only
from observations captured during the actual paired run.
