# Agent benchmark pilot protocol

The same CLI is the sole M1 v2 campaign entry. Generate a bounded dry plan
without product/provider execution as follows:

```sh
bun run benchmark:agents -- plan --campaign m1-v2 --seed 20260812 \
  --run-id m1-v2-plan --source-root "$PWD" --run-root /fresh/run-root \
  --controlled-model openai/gpt-5.6-sol --controlled-reasoning medium \
  --source-revision <exact-40-character-source-sha> --repetitions 3
```

M1 `run` uses this same planner/workflow/report path and never preflights or
executes Hermes/OpenCode. The final four-by-three remains reserved for
`T-M1-V2-FINAL-BENCHMARK`.

The M1 source checkout must be clean at the exact `--source-revision`; unlike
the historical cross-agent pilot, M1 is not forced to the old comparison SHA.
Once `manifest.json` exists, the run root accepts only an identical resume.
Changing seed, source revision, fixtures, or plan identity requires a new run
root and cannot overwrite the existing manifest, result, or terminal evidence.

The benchmark compares Butler, Hermes Agent, and OpenCode using the pinned
`origin/main` baseline `549463fbe074fc25042f9302cd330699948dab50`.

1. Install and authenticate external CLIs outside the benchmark process using
   the official [Hermes documentation](https://hermes-agent.nousresearch.com/docs/)
   and [OpenCode installation documentation](https://github.com/anomalyco/opencode#installation).
   Do not place credentials in a fixture, result, or report. For the corrected
   2026-08-09 pilot, use Hermes Agent 0.20.0 and OpenCode 1.18.15 already
   authenticated in their normal per-user stores.
2. Choose one unsigned 32-bit seed and keep it in the generated plan. Do not
   reuse a run root between pilots.
3. Run `bun run benchmark:agents -- pilot --seed SEED --controlled-model
   openai/gpt-5.6-sol --controlled-reasoning medium --run-root RUN_ROOT --source-root
   PINNED_CHECKOUT --output RUN_ROOT/report --execute-available`.
   This canonical pilot materializes exactly 12 controlled arms: four per
   agent. A run without `--execute-available` remains a truthful 12-arm
   preflight-only report; it does not launch product commands.
4. Inspect the preflight gates before interpreting any result. A missing
   executable, authentication state, effective model, or usage measurement is
   a typed gate; it is not a zero score.
5. The compact pilot executes controlled arms only. For each agent, run the
   direct-conversation cold arm immediately followed by its paired warm arm;
   then run one cold current-web-research arm and one cold Butler landing-page
   arm. All four use the controlled `openai/gpt-5.6-sol`/`medium` configuration.
   Direct cold/warm arms use fresh sessions and output workspaces while sharing
   only their benchmark-owned cache pair and any provider-side cache. Web and
   landing are cold-only. The report uses provider cache-read/write token
   fields when the CLI exposes them. Opaque server-side caches cannot be
   flushed by this runner and are reported as observed rather than claimed to
   be cold.
6. The recommended-default configuration remains defined and supported for a
   later comparison, but it is not applied or separately verified in this
   canonical pilot. A future recommended-default run must use a new run root;
   its results must not be pooled with the controlled pilot.
7. Controlled Butler receives the explicit model, requested reasoning, and
   full-access harness configuration. The harness cannot introspect or bound
   Butler's product-default tools and customization, so those fields remain
   `product-default`/unknown rather than being claimed as reduced controls.
   Controlled Hermes uses official `--safe-mode`, explicit model, web/file
   toolsets, and the transient `HERMES_WRITE_SAFE_ROOT` environment boundary
   while retaining the normal credential HOME. Controlled OpenCode uses an
   arm-owned HOME, XDG config directory, OPENCODE_CONFIG_DIR, and cache while
   pointing XDG_DATA_HOME at the existing normal auth data parent without
   copying credentials; an unverifiable parent is a configuration gate.
   Recommended-default retains the normal HOME/config/data surface. Any
   residual global config merge remains visible as a configuration gate rather
   than being silently normalized. Hermes uses its
   official `--reasoning medium` control. Its direct fixture uses the real
   resumable quiet-chat surface plus content-free aggregate session counters;
   its single-turn fixtures write benchmark-owned usage reports. OpenCode uses
   `--variant medium`; Butler uses the Electron harness reasoning option. Butler landing evidence is
   copied into the read-only relative namespace `.benchmark-input/repository`;
   generated `README.md` and `package.json` remain at the workspace root.
8. Review web citations against primary or authoritative sources and review the
   landing page at desktop and mobile sizes. Record human visual scores with
   reviewer label and rubric version in a small JSON file matching the checked-in
   visual-review schema, then rerun the same run root with
   `--visual-review REVIEW.json`. The review file contains only arm keys, a
   1–5 score, a safe reviewer label, and a pinned rubric version; it contains no
   screenshot paths or prompts. This applies the score to landing observations
   before the report is regenerated.
9. Compare only groups with complete observations and eligible token usage.
   The report withholds ranking when an agent is missing or gated.

The runner records relative evidence references and bounded diagnostics. It
does not record raw prompts, transcripts, tool arguments/results, credentials,
private absolute paths, or hidden reasoning. Product fixes discovered during a
pilot are follow-up work and must not be applied to the benchmark baseline.
