# Agent benchmark pilot protocol

The benchmark compares Butler, Hermes Agent, and OpenCode using the pinned
`origin/main` baseline `549463fbe074fc25042f9302cd330699948dab50`.

1. Install and authenticate external CLIs outside the benchmark process using
   the official [Hermes documentation](https://hermes-agent.nousresearch.com/docs/)
   and [OpenCode installation documentation](https://github.com/anomalyco/opencode#installation).
   Do not place credentials in a fixture, result, or report.
2. Choose one unsigned 32-bit seed and keep it in the generated plan. Do not
   reuse a run root between pilots.
3. Run `bun run benchmark:agents -- pilot --seed SEED --controlled-model
   MODEL --controlled-reasoning medium --run-root RUN_ROOT --source-root
   PINNED_CHECKOUT --output RUN_ROOT/report --execute-available`.
4. Inspect the preflight gates before interpreting any result. A missing
   executable, authentication state, effective model, or usage measurement is
   a typed gate; it is not a zero score.
5. Keep controlled and recommended-default tracks separate. Each scenario has
   a cold arm immediately followed by a warm arm for each agent. Both arms use
   fresh sessions and output workspaces; only the benchmark-owned cache root
   and provider-side cache are allowed to carry. The report uses provider
   cache-read/write token fields when the CLI exposes them. Opaque server-side
   caches cannot be flushed by this runner and are reported as observed rather
   than claimed to be cold.
6. Controlled Butler receives the explicit model, requested reasoning, and
   full-access harness configuration. The harness cannot introspect or bound
   Butler's product-default tools and customization, so those fields remain
   `product-default`/unknown rather than being claimed as reduced controls.
   Controlled Hermes uses official `--safe-mode`, explicit model, web/file
   toolsets, and the transient `HERMES_WRITE_SAFE_ROOT` environment boundary
   while retaining the normal credential HOME. OpenCode uses an isolated
   config/cache root and inline permission config while retaining its normal
   auth data root; any residual global config merge remains visible as a
   configuration gate rather than being silently normalized. Hermes exposes no
   official per-run reasoning-effort flag, so its controlled reasoning/variant
   is recorded as unavailable; the requested reasoning value is applied where
   Butler or OpenCode exposes an explicit option. Butler landing evidence is
   copied into the read-only relative namespace `.benchmark-input/repository`;
   generated `README.md` and `package.json` remain at the workspace root.
7. Review web citations against primary or authoritative sources and review the
   landing page at desktop and mobile sizes. Record human visual scores with
   reviewer label and rubric version in a small JSON file matching the checked-in
   visual-review schema, then rerun the same run root with
   `--visual-review REVIEW.json`. The review file contains only arm keys, a
   1–5 score, a safe reviewer label, and a pinned rubric version; it contains no
   screenshot paths or prompts. This applies the score to landing observations
   before the report is regenerated.
8. Compare only groups with complete observations and eligible token usage.
   The report withholds ranking when an agent is missing or gated.

The runner records relative evidence references and bounded diagnostics. It
does not record raw prompts, transcripts, tool arguments/results, credentials,
private absolute paths, or hidden reasoning. Product fixes discovered during a
pilot are follow-up work and must not be applied to the benchmark baseline.
