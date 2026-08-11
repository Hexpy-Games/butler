# M1 v2 canonical segment-attribution baseline

These checked-in prompts and landing starter files are public benchmark
fixtures recovered byte-for-byte from the four authoritative `custom_tool_call`
records named in `provenance.json`. The original `low` reasoning setting is
provenance only. Canonical v2 runs use ordinary, non-fast
`openai/gpt-5.6-sol` with `medium` reasoning.

Run the bounded campaign after building the App UI:

```text
bun run benchmark:m1-v2-segment-attribution -- \
  --output-root /fresh/private/run-root \
  --source-data /authenticated/butler-data \
  --repetitions 3 \
  --source-revision <exact-source-sha>
```

The runner invokes `runBtccR3ElectronHarness` directly. It creates a new Butler
data root, Electron profile, Session, workspace, and SQLite state for every
repetition. `direct-warm` keeps its warmup and target in the same Session and
passes matched expected/observed cache-boundary evidence. Arms and repetitions
are sequential; a harness/auth/browser infrastructure failure is recorded as a
gate and stops the remaining campaign rather than substituting another run.

Acceptance uses only target Agent attempts carrying the arm ID. Title and
auxiliary physical attempts remain counted separately. Every Agent envelope
must be unique and eligible, have mutually exclusive unique segment IDs, at
most one nullable usage row, an exact UTF-8 byte sum, and aggregate
`other_typed_context <= 2%` for the repetition. Retry/cache/terminal failures
are rejected, never replaced.

The fixed web rubric requires the requested 2026-08-10 date, an umbrella
recommendation, public-source links, an observed web tool call, and nonzero
`source_reference` bytes. Landing acceptance requires changed original files,
a passing build, App final reload persistence, overflow-free desktop/mobile
renders and screenshots, Butler-grounded content, three feature blocks, a use
scene, CTA, responsive CSS, and product DB evidence for file mutation, build,
and `inspect_workspace_page` calls. All discovered SQLite databases must pass
`PRAGMA quick_check`.

Raw per-run product evidence stays under the private output root. The aggregate
`campaign.json` stores only bounded counts, booleans, timing, nullable usage,
and byte totals/ranges; it excludes prompt/final text, URLs, queries, private
paths, credentials, raw tool payload/results, and hashes of generated private
content.
