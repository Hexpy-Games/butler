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

## DS View parity (B1 primitives)

`ds-view.ts` captures the React DS Viewer pages listed in `scenes/ds-view.json`; the native
side is `butler-ds-view --shots`. It needs the repository's JavaScript dependencies (`bun install`
at the repository root and in `packages/butler-app/client/ui`, as `run.ts` does for its imports)
and a Chromium that Playwright can find. Build the static viewer, capture, then render the native
pages at the React canvas width and diff:

```sh
export HOME=$(mktemp -d) BUTLER_DATA=$(mktemp -d) PLAYWRIGHT_BROWSERS_PATH=/path/to/ms-playwright
(cd packages/butler-app/client/ui && DS_SITE_OUT_DIR=$TMPDIR/ds-site npm run build:ds-site)
bun packages/butler-shell/tools/parity/ds-view.ts --site $TMPDIR/ds-site --out $TMPDIR/ds-parity
# <canvas-width> is the "w" of any story in $TMPDIR/ds-parity/react/<size>-<theme>/<page>.layout.json
butler-ds-view --shots $TMPDIR/ds-parity/gpui/1280x800-light --scale 2 --size 1280x800 \
  --canvas-width <canvas-width> --full
parity-diff $TMPDIR/ds-parity/react/1280x800-light $TMPDIR/ds-parity/gpui/1280x800-light \
  $TMPDIR/ds-parity/diff/1280x800-light
```

### B2 pages, state shots and the summary

`scenes/ds-view.json` lists the B1 and B2 pages. `ds-view-states.ts` captures the interactive
states of `scenes/ds-view-states.json` (hover, press, focus, click) as `<page>.<name>.png` plus
`<page>.<name>.json` next to the page crops (`--only page,page` limits it). A `target` is the 0-based
index of the control in DOM order over all `[data-ds-fixture-canvas]` of the page (`button`,
`[role=button|radio|switch]`, `input[type=range]`, `[tabindex="0"]`, deduped). Each state shot is the
owning story canvas plus 64 logical px on every side, clipped to the window; the native live harness
uses the same rule. `ds-view-summary.ts --react <dir> --gpui <dir> --diff <dir> --parity-diff <exe>`
prints the per-page, per-state and per-story geometry tables for one `<size>-<theme>` pair.

The native side of the state shots is `butler-ds-view --live <dir> --scale 2 --size 1280x800 --canvas-width 650
[--dark]` (feature `shots`): commands on stdin (`page <id>`, `hover|move|press|click|focus <n>`, `release`,
`key <keystroke>`, `wait <ms>`, `expect ...`, `shot <name>`, `quit`), each answered `LIVE OK`. `<n>` is the
control's number in render order (DOM order of the page, as the `target` of the states scene).
