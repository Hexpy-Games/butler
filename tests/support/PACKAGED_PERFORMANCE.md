# Packaged performance measurement

Use the measurement command around an isolated packaged Electron run. The
driver must provide the Electron browser/main, renderer, GPU, utility, App
Gateway, bundled Agent, embed, and owned-sidecar process IDs for the physical
memory gate. Multiple renderer, utility, or sidecar processes are preserved by
adding a label after the PID (`role:pid:label`). The original three-role form
remains accepted for Sandy-only compatibility.

Capture the baseline after the App is healthy:

```bash
bun run app:client:performance:report -- snapshot \
  --butler-data "$BUTLER_DATA" \
  --process electron_main:$ELECTRON_MAIN_PID \
  --process electron_renderer:$ELECTRON_RENDERER_PID \
  --process electron_gpu:$ELECTRON_GPU_PID \
  --process electron_utility:$ELECTRON_UTILITY_PID:network-service \
  --process app_gateway:$APP_GATEWAY_PID \
  --process agent_runtime:$AGENT_PID \
  --process embed:$EMBED_PID \
  --process owned_sidecar:$SYNC_PID:sync-consumer \
  --require-full-roles \
  --cycle-index 0 --phase warmup \
  --output before.json
```

Capture one snapshot per deterministic fixture cycle. Warm-up cycles are
excluded from the plateau series; at least six steady-state snapshots are
required for the numeric gate. The same process target list and data fixture
must be used for every cycle. `--output -` is a stdout sentinel and never
creates a file named `-`.

The E2E driver records the existing forward-progress fields and these healthy
transport counters while it runs:

```text
sessionViewRequests
liveStreamConnections
liveEvents
heartbeatEvents
reconcileRequests
```

Write a report manifest containing the fields accepted by
`ElectronForwardProgressBenchmarkInput`, replace `afterSnapshot` with
`processTargets`, and include the captured snapshot as `beforeSnapshot`. For the
physical gate, add `cycleSnapshots` (the warm-up-excluded series),
`requiredProcessRoles` (normally all eight declared roles), and an
`idleReclamation` record:

```json
{
  "requiredProcessRoles": [
    "electron_main", "electron_renderer", "electron_gpu",
    "electron_utility", "app_gateway", "agent_runtime", "embed",
    "owned_sidecar"
  ],
  "idleReclamation": {
    "baselineBytes": 12000000,
    "loadedBytes": 3500000000,
    "afterIdleBytes": 14000000,
    "maxBaselineMultiplier": 1.5
  }
}
```

Then produce the final structured report:

```bash
bun run app:client:performance:report -- report \
  --input performance-manifest.json \
  --output performance-report.json
```

The report records cumulative process CPU and RSS samples, per-role physical
footprint/private resident/VSZ, native/external heap where available,
connections/handles, macOS `vm_stat` compressor and `vm.swapusage` system
samples, operational Agent metrics, before/after growth for every SQLite/DB
file under the isolated data root, transport counts, cache usage, and forward
progress. Unsupported counters are `null` with an explicit reason; zero is
never used as a substitute for an unavailable counter.

`physicalGate` is independent of the Sandy gate. It uses physical footprint on
macOS, private resident on Linux, and RSS only on platforms without a stronger
counter. All declared roles must contribute to the selected metric. The final
three steady-state medians may be no more than 10% above the first three, and
the series may not grow monotonically. Open handles/connections use the same
monotonic-growth check. The embed idle gate requires a model-loaded sample and
an after-idle sample within the configured unloaded-baseline class. VSZ is
reported for diagnosis but never passes the gate.

## Bun runtime A/B

Task RMF-SC10 compares two manifests produced by the same real-product campaign
driver. The `--bun` option starts the campaign in the requested Bun subprocess;
the campaign propagates that executable into the App-managed runtime resource
and records outer, bundled, and managed `--version` evidence. Each variant
uses a fresh isolated run root/profile/data/cache. The manifest must carry
identical source/data fingerprints, warm-up and steady cycle counts,
role/label attribution, and cache policy/resource identity. PIDs may differ.
Portable reports contain bounded runtime labels and stable fingerprints only;
local run roots, executable paths, and command arguments remain private to the
run directory.

```bash
bun run app:client:performance:bun-ab -- versions \
  --pinned-bun /path/to/bun-1.3.11 \
  --candidate-bun /path/to/bun-1.3.14

# Produce command-derived archive evidence for each executable. The local guard
# may use absolute executable/argument paths, but its portable artifact stores
# only bounded executable/command labels and stable fingerprints (never raw
# paths, arguments, or run roots), plus exactly ten successful attempts; a
# boolean flag is not accepted.
bun run app:client:performance:bun-ab -- archive-guard \
  --parent packages/butler-app/client/electron/node_modules/.bin/electron \
  --arg --no-sandbox \
  --arg tests/support/archive-stream-electron-parent-app \
  --arg packages/butler-agent/resources/runtime/posix-archive-worker.mjs \
  --arg /path/to/agent-archive.tar.gz \
  --arg "$RUN_ROOT/archive/runtime" \
  --arg "$RUN_ROOT/archive/runtime/inventory.json" \
  --bun "$PINNED_BUN" \
  --attempts 10 \
  --output "$RUN_ROOT/archive-guard-pinned.json"

bun run app:client:performance:bun-ab -- packaging-guard \
  --bun "$PINNED_BUN" \
  --repo-root "$REPO_ROOT" \
  --output "$RUN_ROOT/packaging-guard-pinned.json"

# Reuse the same source/data/warmup/steady/idle options for both variants.
bun run app:client:performance:bun-ab -- campaign \
  --bun "$PINNED_BUN" --variant pinned \
  --repo-root "$REPO_ROOT" --source-data "$SOURCE_DATA" \
  --run-root "$RUN_ROOT/pinned" --warmup-cycles 3 --steady-cycles 6 \
  --history-messages 1200 --idle-wait-ms 47000 \
  --archive-evidence "$RUN_ROOT/archive-guard-pinned.json" \
  --packaging-evidence "$RUN_ROOT/packaging-guard-pinned.json" \
  --output "$RUN_ROOT/pinned-evidence.json"

# Repeat archive/packaging/campaign for the candidate Bun in a new run root.
bun run app:client:performance:bun-ab -- campaign \
  --bun "$CANDIDATE_BUN" --variant candidate \
  --repo-root "$REPO_ROOT" --source-data "$SOURCE_DATA" \
  --run-root "$RUN_ROOT/candidate" --warmup-cycles 3 --steady-cycles 6 \
  --history-messages 1200 --idle-wait-ms 47000 \
  --archive-evidence "$RUN_ROOT/archive-guard-candidate.json" \
  --packaging-evidence "$RUN_ROOT/packaging-guard-candidate.json" \
  --output "$RUN_ROOT/candidate-evidence.json"

bun run app:client:performance:bun-ab -- manifest \
  --pinned-evidence "$RUN_ROOT/pinned-evidence.json" \
  --candidate-evidence "$RUN_ROOT/candidate-evidence.json" \
  --output "$RUN_ROOT/bun-runtime-ab-manifest.json"

bun run app:client:performance:bun-ab -- compare \
  --input "$RUN_ROOT/bun-runtime-ab-manifest.json" \
  --output "$RUN_ROOT/bun-runtime-ab-report.json"
```

The comparator permits a candidate recommendation only when Bun versions are
the expected 1.3.11/1.3.14 pair, the physical gate and correctness checks pass,
the archived Electron-parent archive-stream guard and packaging checks pass,
and the candidate improves the gated physical ratio by at least the comparator's
5% relative noise margin without worsening the resource ratio. The archive
guard must include ten successful execution attempts for each runtime; a
boolean without those attempts is ineligible. Missing or mismatched cache
policy/resource identities are descriptive only and force a `keep-pinned`
no-change recommendation.
