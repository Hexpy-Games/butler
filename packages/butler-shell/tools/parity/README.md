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

`key <keystroke>` sends the key going down and coming up (Enter and Space activate on release);
`expect anchor <name>` passes when the page has the named zero-size marker (a story names the value its
control holds, e.g. `value-percent-50`, so a smoke can check what a click or key changed);
`--motion` keeps motion on (the default reduces it, so every frame is at rest; the Spinner is exempt and
always runs). The React states scene lists the NavRow controls of the ProgressRing page, which the native
page does not have yet, so its `advance-click` target is 0 natively.

### B3 additions (scroll, collapsible, tabs)

`ds-view-states.json` also has `scroll` states (`target` is the story index; `dx`/`dy` scroll its first
edge-fade scroller), `clicks` (a click repeated, 700 ms apart) and an optional `native` control number
for pages where the viewer counts more tab stops than the native page (the Tabs page: tablists and
tab panels). The live harness gains `scroll <story> <dx> <dy>` (the wheel over story n, 0-based; positive
moves further along the content); `focus <n>` now also points the next `shot` at the control's story.
ScrollArea stories name zero-size markers (`expect anchor scroll-overflows:start|middle|end|fits`).

### B3 additions (text fields)

The viewer's state-target selector now also counts `input`, `textarea` and `select`. The live harness gains
`type <text>` (`replace_text_in_range` on the focused field's input handler), `ime-mark <text>` (IME
composition: `replace_and_mark_text_in_range`, the marked text underlined, caret at its end) and
`ime-commit <text>` (`replace_text_in_range` over the marked text). `Input::probe(name)` and
`Textarea::probe(name)` name markers `<name>:<text>`, `<name>:caret:<utf16 index>` and
`<name>:marked:<start>-<end>|none` for `expect anchor`. Korean smoke: `page input`, `click 0`, `key cmd-a`,
`key backspace`, `type ab`, `ime-mark ㅎ`, `ime-mark 하`, `ime-mark 한`, `expect anchor input-server-id:ab한`,
`ime-commit 한`, `ime-mark ㄱ`, `ime-mark 그`, `ime-mark 글`, `ime-commit 글`,
`expect anchor input-server-id:ab한글`, `expect anchor input-server-id:caret:4`.

### P2-S2 additions (layout shells)

The shell showcases lay a 1440px or 1100px window out and scale it into the story (the viewer's
`ScaledFrame`). gpui's element scale composites a layer the size of the window, so a scaled layout must fit
inside it: pass `--stage-width 2400` to `--shots` and `--live` (a real window that wide, the viewer laid out
for `--size`; `app::logical_viewport` is what pages read as the window). A page taller than a readback buffer
(`MAX_WINDOW_HEIGHT`) is shot in a window of that height and scrolled to each story; `ds-view.ts` does the
same on the React side by scrolling each canvas to the top before cropping it. Harness anchors the new
pages name: `adaptive-toggle`, `adaptive-open-nav`, `adaptive-open-inspector`, `split-browser-toggle`,
`split-handle`, `split-chat-<width>` (the chat column's width after a drag), `peek-edge-zone`, `peek-card`,
`peek-edge-button`, `peek-true|false` and `jump:<label>`.

### P2-S3 additions (navigation and row blocks)

`scenes/ds-view.json` lists the eleven new pages (`nav-row`, `nav-section`, `collapsible-nav-group`,
`nav-drop-target`, `drag-preview`, `overflow-action-menu`, `list-row`, `disclosure-row`, `key-value-row`,
`empty-line`, `status-capsule`). The live harness gains `dragto <n|@anchor>[+dx,dy] [ms]`: the held pointer
(after `press`) travels to the target in 16 ms steps, each move carrying the held left button, so a gpui
`on_drag` starts and `on_drag_move` runs; `release` then drops. A NavDropTarget row has the anchor
`nav-drop:<key>`; the interactive story names `ndt-order:<ids>`, `ndt-groups:<id>><label>` and
`ndt-dragging:<bool>`. Other anchors: `cng-space-open-<bool>` (CollapsibleNavGroup), `kv-highlight-<label|none>`
(linked KeyValueRow), `dp-stage-<kind>-invalid-<bool>` (DragPreview). Drag smoke:
`viewport 3000`, `page nav-drop-target`, `press @nav-drop:demo-0`, `dragto @nav-drop:demo-2+0,-10 400`,
`wait 300`, `shot drag-before`, `release`, `expect anchor ndt-order:demo-1,demo-0,demo-2,demo-3,demo-4`.
