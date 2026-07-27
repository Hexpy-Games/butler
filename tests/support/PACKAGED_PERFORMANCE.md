# Packaged performance measurement

Use the measurement command around an isolated packaged Electron run. The
driver must provide the Electron main, renderer, and bundled Agent process IDs.

Capture the baseline after the App is healthy:

```bash
bun run app:client:performance:report -- snapshot \
  --butler-data "$BUTLER_DATA" \
  --process electron_main:$ELECTRON_MAIN_PID \
  --process electron_renderer:$ELECTRON_RENDERER_PID \
  --process agent_runtime:$AGENT_PID \
  --output before.json
```

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
`processTargets`, and include the captured snapshot as `beforeSnapshot`. Then
produce the final structured report:

```bash
bun run app:client:performance:report -- report \
  --input performance-manifest.json \
  --output performance-report.json
```

The report records cumulative process CPU and RSS samples, operational Agent
metrics, before/after growth for every SQLite/DB file under the isolated data root,
transport counts, cache usage, and forward progress. Only the existing Sandy
forward-progress gate is evaluated. CPU, RSS, storage, interaction, and
transport measurements remain evidence for the product run until governing
numeric targets are accepted.
