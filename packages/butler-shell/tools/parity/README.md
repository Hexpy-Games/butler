# Screenshot parity

Run on the Mac mini. Each scene uses one isolated stub agent shared by Electron
and the headless gpui shell. Differences are review output; there is no threshold.

Build the renderer and agent using the repository's existing build instructions.
Build `butler-shell-shots` with the `shots` feature and `parity-diff` in the shell
workspace, using `~/bin/heavy`, the required build queue and an isolated HOME and
BUTLER_DATA. Set these executable paths when using a temporary target directory:

```sh
export BUTLER_NATIVE_AGENT_EXECUTABLE=/absolute/path/to/butler-agent
export BUTLER_SMOKE_ELECTRON_EXECUTABLE=/absolute/path/to/Electron
export BUTLER_SMOKE_RENDERER_DIST=/absolute/path/to/renderer/dist
export BUTLER_SHELL_SHOTS_EXECUTABLE=/absolute/path/to/butler-shell-shots
export BUTLER_PARITY_DIFF_EXECUTABLE=/absolute/path/to/parity-diff
export HOME=$(mktemp -d) BUTLER_DATA=$(mktemp -d) BUTLER_E2E_TIER=stub
bun packages/butler-shell/tools/parity/run.ts chat-long approval new-chat \
  --out "$TMPDIR/butler-parity" --sizes 1280x800,390x844 --themes light,dark --scale 2
```

Open `report.html` in the output directory. PNGs and logical-pixel layout JSON
are under `electron/` and `gpui/`; heatmaps are under `diff/`. Child diagnostics
and PIDs are under `logs/`. The Electron helper manages its own file-backed logs
and child cleanup. All children are stopped on completion, error or interruption.

Scene seed steps use the agent HTTP API. `${session}` refers to the most recently
created session. `${message.N}` refers to the zero-based message in its final
session view. `wait: true` waits for delivery before proceeding. Anchor names
match gpui debug selectors; `electron` supplies the corresponding CSS selector.
Missing or virtualized anchors are reported, without substituting other elements.

For gpui-to-gpui review, run `parity-diff <dirA> <dirB> <outDir>` directly. Exact
RGBA differences are counted. Different dimensions and missing pairs are printed;
matching dimensions produce a PNG overlay on B with magenta differences at 60%
and grey at 30% elsewhere.
