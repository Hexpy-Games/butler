# Safe composer decoration themes

Status: research/design, 2026-10-03; no product implementation or mockups.
Issue: [#474](https://github.com/Hexpy-Games/butler/issues/474).
Branch: `codex/composer-ideas-research`.
Owner request: **컴포저 안 인터렉티브/정지 배경화면**.

## Intent and authority

Optional static or typing-reactive flowers, falling petals and characters decorate the composer without ever occupying the text/caret/selection area. Users select a theme or import their own. Deliver safe static imports first, then bounded interactive packs through the same declarative renderer; do not end the project at built-in-only themes.

Baseline `10b68356da71fafdd3c5551ef7cb62d51ee35da3`; [approved work-model direction at 0df4b620](https://github.com/Hexpy-Games/butler/blob/0df4b6203b82922fc77cadd2cd41e7fac79d0b35/plans/work-model/work-model-design.md), §§2/3/5. Decorations are appearance, never agent work, instruction, tool, permission or model context. Preserve that design's Ledger/SQLite ownership and event-driven views. No Spec/Work/Task creation from typing or theme selection.

Goals: readable text, unchanged editor behavior, predictable cost, offline personalisation, accessible motion choice, safe untrusted imports. Non-goals: live wallpaper replacement, marketplace/cloud sync, AI asset generation, arbitrary scripts/shaders, sound, clickable characters, game engine, Lottie/Rive file imports, telemetry of writing, agent personality or execution state.

## Source evidence and integration gaps

`UI = packages/butler-app/client/ui/src/`; `R = packages/butler-agent/rust/`. File:line observations are static evidence, not measured performance.

| Current behavior | Evidence | Consequence |
|---|---|---|
| Lexical ContentEditable owns composition; editor is keyed by draft session. | `UI/components/conversation/ComposerTextArea.tsx:29`, `:40` | Add a local input signal; no overlay editor or remount on theme change. |
| Existing listener serializes content to composer state when dirty. | `UI/components/conversation/editor/ComposerEditorPlugin.tsx:51` | Decorations must not subscribe to full text or duplicate serialization. |
| All element motion enters DS `animateMotion`, reading motion tokens. | `UI/libs/design-system/lib/motion.ts:53`, `:128` | Cache theme timing outside input handler; use DS-owned animation. |
| Reduced-motion reads OS media + body `data-motion`; subscriber is change-driven. | `UI/libs/design-system/lib/motion.ts:62`, `:78` | Reuse effective reduced-motion signal, do not create a private preference. |
| Wallpaper has visibility, intersection, reduced-motion and optional browser battery events. | `UI/libs/design-system/blocks/Wallpaper/signals.ts:17`, `:32` | Reuse signal patterns; battery absence is not proof of AC power. |
| Wallpaper scheduler runs animated scenes at 20fps, has periodic day-phase and retry behavior. | `UI/libs/design-system/blocks/Wallpaper/scheduler.ts:5`, `:103`, `:130` | Do not reuse its continuous scheduler for the no-idle-work composer. |
| Existing main-screen settings expose wallpaper motion and battery switches. | `UI/components/settings/MainScreenThemeSettings.tsx:67`, `:74` | Wallpaper-specific motion setting must not silently become a second global motion preference. |
| Wallpaper archives accept shader.frag and bounded assets. | `R/crates/butler-gateway/src/gateway/wallpaper_modules/import.rs:4`, `:70` | Reuse secure archive principles, never accept shader packs as composer packs. |
| Wallpaper image pipeline sniffs formats, caps allocation, re-encodes metadata away. | `R/crates/butler-gateway/src/gateway/wallpaper_store/pipeline.rs:21`, `:56` | Reuse decoding primitives with tighter composer limits; do not copy a second image pipeline. |
| TintedGlass draws an explicit tint, border and background over content. | `UI/libs/design-system/components/TintedGlass/TintedGlass.module.css:1` | Art may not undermine text contrast or reach panel/pill controls. |

The owner states the app now has a reduce-motion setting. In this baseline, source search verified the DS/OS signal and wallpaper motion switch, but did not locate a persisted global app reduce-motion field. This is an **integration gap to reconcile with the coordinating branch**, not a request to invent a new toggle. Implementation must connect that existing setting to the shared effective signal and prove live updates in smoke; do not claim the current wiring is verified.

Open/closed issue searches on 2026-10-03 covered composer/컴포저/wallpaper/glass/decoration; wallpaper issues #390/#395 and historical composer #25 do not cover this request. #474 is its single feature issue.

## Primary prior art and rendering decision

All sources accessed **2026-10-03**. Cost judgments are architectural estimates; no backend is proven under Butler's <1ms requirement yet.

| Option and official source | Strength | Cost/risk and decision |
|---|---|---|
| [CSS/compositor guidance, Chrome](https://web.dev/articles/animations-guide) | Transform/opacity animation can avoid layout/paint; simplest fixed sprites. | DOM/layer count and backdrop interaction still cost memory/GPU. **Recommend ≤24 sprites and DS finite animations**, with no animated blur/filter/layout. |
| [SVG 2 processing modes](https://www.w3.org/TR/SVG2/conform.html) | Sharp built-in vector art; image embedding has different script/resource rules than inline documents. | Full SVG accepts active features; path/filter complexity is unbounded. Allow reviewed bundled SVG only; imported SVG is rejected in v1. Not a generic SVG sanitizer project. |
| [OffscreenCanvas, Mozilla](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas) | Canvas/worker rendering can move drawing off the main thread; suitable for many particles. | Worker messaging, buffers, lifecycle and fallback increase complexity; main-thread canvas competes with text. Defer until a measured visual need exceeds bounded sprite capability. |
| [WebGL specification, Khronos](https://registry.khronos.org/webgl/specs/latest/1.0/) | Efficient batched particles, GPU composition. | Context/shader compilation, context loss, GPU memory and power; arbitrary shaders violate pack policy. Existing wallpaper WebGL engine is not justification for another context. Defer. |
| [lottie-web repository](https://github.com/airbnb/lottie-web) | Designer export workflow, SVG/canvas/HTML renderers, play/pause/segments. | Runtime/layer work, supported expressions and external assets mean JSON alone is not a security boundary. No direct imports; possible future offline conversion to the approved small format. |
| [Rive Web runtime](https://rive.app/docs/runtimes/web/web-js) | Interactive state machines and JS/WASM rendering; can control loop and cleanup. | Additional runtime/WASM and explicit object lifecycle; runtime feature set includes scripting. Powerful for characters but unnecessary v1 trust/size surface. No direct .riv imports. |

Supporting primary contracts: [WCAG interaction animation](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html) supports disabling nonessential motion; [Chrome page lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api) informs hidden/frozen cleanup; [W3C CSP3](https://www.w3.org/TR/CSP3/) supplies defense-in-depth restrictions, not validation of pack data; [UI Events composition](https://www.w3.org/TR/uievents/#events-compositionevents) separates committed edits from IME candidate activity.

Recommendation: static raster poster + small raster/bundled-vector sprite set, rendered by one DS presenter with predefined `sway`, `fall`, `hop` transforms. Imported packs supply assets and bounded numbers/enums only. The static renderer is also the reduced-motion/battery/error fallback. No generic animation runtime in the initial payload.

## Layout and visible states

Compose inside the input surface specified by [control-pill design](control-pill-design.md); the 8px gap and pill stay free of art. A **dedicated top band inside the input card** reserves 24px at 375px width and 32px at 1280px. It is zero-height for Off. Characters can look seated on the editor's upper edge but remain inside this allocated band; no negative offsets outside the card. Flowers sway in the band, petals fall only within it. Theme authors cannot change these dimensions.

The band is disjoint from the editor's entire text/placeholder/caret/selection/scrollbar/attachment rectangles, separated by an 8px quiet strip. Text keeps the same width and padding as without art; a multiline editor scrolls below the fixed band. Full wallpaper behind typed text, even faintly, is excluded. Later mockups may use side bands only if they prove the same disjoint geometry without reducing text width.

At 375: 343px card, 24px band; at 1280: up to 760px card, 32px band. Art is clipped to its band and does not float over pending questions, decisions, toasts, mention pickers or file-drop targets. Light/dark packs provide variants or use one approved neutral asset; TintedGlass and an independent editor contrast floor retain readable text on white/black/busy wallpaper. Asset colors do not set UI text/control tokens.

| State | Visible result and behavior |
|---|---|
| Off (recommended initial default) | No band, assets, listeners or animation module loaded. |
| Static | Poster in reserved band; no typing listener or frame scheduling. Theme/light-dark/size changes can redraw once. |
| Interactive, ready | Same poster, no active animation. A committed user edit starts a bounded response. |
| Interactive, responding | Sway/fall/hop within band; rapid edits coalesce to bounded intensity without new nodes. |
| Reduced motion / battery pause | Immediately cancel motion, display poster. No per-key opacity pulses. Saved interactive selection remains for later use. |
| Hidden / occluded / editor collapsed | Cancel animations and release active scheduling; collapsed preview has no band. Resume at poster, never catch up missed input. |
| Active question/decision | Remove the decoration band while input is replaced, retaining selected theme and draft. No animation behind exact approval actions. |
| Loading / import failure / missing asset | Keep previous valid theme; first load uses Off. Short toast such as `가져올 수 없습니다`; editor always works. |

Theme picker lives in existing Appearance settings: `컴포저 장식`, select `없음`/theme name, mode `정지`/`입력 반응`, action `가져오기`. Reuse DS SettingsSection/SettingsField/Select/Switch/ButtonContainer/Dialog/Toast. Optional shortcut from existing composer More opens this section; no permanent extra pill button. Preview shows a poster and a single `미리 보기` action; never animates every thumbnail. Import stages a pack and shows name/author/license/poster before `적용`; cancel keeps the current theme.

All art is `aria-hidden`, nonfocusable, pointer-events none, no live region or semantic progress. Picker labels describe the option, not every flower. No flashing, sound or haptic output. Content supports plain text, references and IME exactly as before. The text contrast and focus checks from feature A apply with decorations at every animation extreme.

## Runtime ownership, input path and energy

Product container owns settings/API and maps immutable theme descriptor to DS props. Extend the DS ComposerCard with a decoration presenter/slot whose geometry it owns. The DS owns clipping, animation, reduced-motion, theme tokens and resource cleanup. It imports no composer store, agent API or app copy. No public className/style escape hatch.

Proposed local contracts (not existing API):

```ts
type ComposerDecorationSetting = {
  version: 1;
  theme: null | { id: string; revision: string };
  mode: "static" | "interactive";
  pauseOnBattery: boolean; // default true
};
type DecorationPulse = { sequence: number }; // local, no text/time history
// DS handle: pulse(DecorationPulse), reset(), dispose().
// DS props: validated scene, mode, effectiveReducedMotion, powerState,
// visible, expanded; callbacks/commands never originate from pack data.
```

Editor emits **one content-free pulse after a committed trusted edit**, outside Lexical serialization: text insertion/deletion, paste or undo/redo each count as one change. Selection moves, programmatic draft restore, navigation, remote model tokens and raw keydown do not pulse. IME: ignore updates while composing; pulse once after committed content changes, deduplicating compositionend/final-input order. Cancelled composition produces none. Never inspect text, key value, caret coordinates, clipboard bytes or Unicode characters for animation.

Hot path is one increment and scheduling at most one pending frame; no state-store write, React rerender, DOM measurement, parsing, disk/network I/O or token/style lookup. DS reads cached motion tokens and geometry on mount/theme/resize only. Next frame updates up to 24 preallocated sprite transforms with the DS motion helper; newer edits update one bounded pending intensity rather than enqueue particles or animations without limit. At most one active finite animation per sprite.

Define an **input response burst** as at most one `--motion-deliberate` duration (currently 320ms) after the latest committed edit. There is no autonomous breeze, idle blink or petal emitter. One event-triggered animation/completion may finish this burst; after completion there are zero decoration timers, rAF callbacks and running animations. Hidden, blur of the editor to another surface, reduced-motion, power pause, panel replacement and unmount cancel immediately. This finite visible response is the only work after an edit; “idle” means no active response burst. No polling to discover idle and no watchdog retry timer.

Use OS reduced-motion **OR** the owner's existing app reduce-motion setting; neither a theme nor Interactive can override reduction. Changes cancel current movement before the next frame and require a new edit to restart after reduction is lifted. DS opacity fallback alone is insufficient here: decorative response must become completely static.

Battery policy is app/device state: use an existing push signal if available; any new native power observer belongs only in `R/crates/butler-platform`, projected through the established bridge. Browser battery events may supplement it. `unknown` power with `pauseOnBattery=true` selects static, with a short setting hint; user may turn off that battery rule, not the reduce-motion rule. No battery polling, process per composer or high-frequency bridge messages. Window/page visibility and intersection changes cancel work; native occlusion gaps need platform evidence. Preview follows the same policy.

## Declarative pack and security contract

Pack v1 is a zip containing only root `composer-theme.json`, mandatory `poster.png`, and explicitly named PNG/WebP sprite assets. A directly imported still PNG/JPEG/WebP becomes a static-only v1 pack through the same validation and preview path. Export a simple template in the future implementation so users can make interactive packs without proprietary authoring tools.

Example manifest; all ranges below are normative for the proposed v1:

```json
{
  "schema": "butler.composer-theme",
  "version": 1,
  "name": "Flower field",
  "author": "Example",
  "license": "CC0-1.0",
  "poster": "poster.png",
  "sprites": [
    { "asset": "flower.png", "anchorX": 0.25, "anchorY": 1,
      "size": 16, "reaction": "sway", "amplitude": 3 }
  ]
}
```

Name ≤64 Unicode characters, author ≤80, license ≤128, rendered as plain text; no markup or clickable URL. `anchorX/Y` finite [0,1], size 4–24 CSS px, amplitude 0–8px; scene coordinates are confined to the band. Allowed reactions `still|sway|fall|hop`; preset timing/easing/trajectory is bundled DS code. Poster assets may optionally have `posterDark`; a sprite may have `assetDark`. Missing dark variant uses its original. Unknown schema/fields/enum, duplicate keys, nonfinite numbers and out-of-range values reject the pack; no expression evaluation or arbitrary keyframes.

Maximum archive 2MiB compressed, 32 entries, 8MiB total uncompressed, 32KiB JSON, 24 sprites, 8 distinct image files including posters. Per image ≤2048px edge; aggregate decoded pixels ≤2,000,000 and transient decoder allocation ≤32MiB. Validate header dimensions before decoding. Reject animated images, SVG, HTML, JS, WASM, shader, fonts, video/audio, nested zip, directories/symlinks, absolute paths, traversal, duplicate/case-colliding names and any unlisted payload. Limit actual bytes read as well as declared zip sizes. Oversized packs fail clearly; do not silently drop sprites/resample content to pass a budget.

Import service validates a strict schema, sniffs/decodes each image with explicit limits and re-encodes it to remove metadata. Shared existing decoder helpers need explicit composer limits; wallpaper's 40MP/256MiB policy is too large. Zip extraction and image work run under bounded `spawn_blocking` concurrency (one import at a time), never on a tokio request worker. Confine writes to a service-selected staging directory using `butler-platform::secure_fs`; the manifest supplies no filesystem path, OS call or storage ID. Atomic install only after complete validation; failure leaves the selected theme unchanged. Startup removes only known abandoned staging records once, no idle filesystem sweep.

The sandbox is a **capability-free declarative interpreter**, not a promise that a Worker/iframe makes arbitrary art safe. Packs cannot run code, bind DOM events, navigate, access native bridge, issue fetch, load remote/data/file URLs or read draft state. Scene data is translated to owned image nodes/preset transforms, never inserted as HTML/CSS. Images are served through authenticated opaque-ID asset routes with fixed MIME and nosniff; CSP remains restrictive and is not widened for imports. No script/worker/WASM origin is added. IDs are hashes of validated canonical content; imports are not auto-updates and names cannot impersonate built-in IDs. Decoder/library vulnerabilities remain a maintenance risk despite data-only execution.

Stored assets/settings are appearance data under the authorized BUTLER_DATA scope, not attachments or model input. Remote client import requires the same authenticated **settings-write capability** as an explicit appearance change, plus existing origin/CSRF and pairing checks; read-only guests cannot import/delete. Never expose absolute paths, credentials or draft text in errors. A pack has no authority to change access mode or execute actions.

## Data/API and durability

Reuse existing settings PATCH and event delivery with a new `composer_decoration` field of the type above; missing field means Off, existing wallpaper settings are unchanged. Setting a theme references exact validated `id/revision`; no latest-by-name resolution. Presentation reads a bounded projection. Explicit selection/mode/save is the only settings write; typing/preview/visibility never persists animation state.

Proposed gateway routes under the existing authenticated API prefix (names to implement, not present today):

| Route | Contract |
|---|---|
| `POST /composer-themes/import` | Bounded bytes; returns staged validated `{id,revision,metadata,previewAssetId}`. Does not select automatically; identical bytes return same identity. Cancel removes the staged import through its scoped ID. |
| `GET /composer-themes?cursor=&limit=50` | Indexed bounded metadata page, stable order/revision and next cursor; complete catalog remains reachable. No archive parsing/directory scan per request. |
| `GET /composer-themes/{id}/{revision}` | Validated scene descriptor + opaque asset IDs, ETag; immutable content can cache. Never returns executable content. |
| `GET /composer-theme-assets/{hash}` | Authorized canonical image bytes only; enforce reference ownership. |
| `DELETE /composer-themes/{id}/{revision}` | Reject `theme_in_use` until user selects Off/another pack; remove only unreferenced assets, never built-ins. |

Settings application validates existence before writing; uses current settings concurrency semantics with explicit expected revision for this field and returns conflict on stale selection. On apply, atomically publish theme availability + selection in the existing storage transaction lane; assets install first, then metadata/reference commit. Crash before metadata commit leaves only named staging for one-time recovery; after commit replay reads exact revision. Do not acknowledge selection before durable reference commit. Pack replacement creates a revision, never mutates an in-use one. Settings/catalog changes emit bounded existing SSE invalidation after commit; snapshot + cursor replay handles reconnect without polling.

Deleting a pack referenced by another window remains refused. Invalid/missing selected bytes at startup show Off with a recoverable setting status, preserving the reference for diagnosis; no silent fetch/download. Loading/decoding does not block editor availability.

## Numeric acceptance budgets and measurement method

All numbers here are **targets**, not benchmark results. Artist capacity limits are declared format constraints, not runtime truncation to satisfy speed. Test the full accepted pack at its limits, with every sprite/image/state preserved.

| Scenario | Budget and correctness proof |
|---|---|
| Input hot path | Added main-thread decoration work p99 <1ms per committed edit, maximum reported; no added >50ms task. ≥1,000 edits at 10/s plus burst paste and Korean IME. Assert exact draft/text/references/undo and emitted pulse count, not just FPS. |
| End-to-end input | Decoration-on versus Off input-to-next-paint p95 delta ≤2ms, p99 delta ≤4ms on same device/build. Report absolute values as well; do not subtract away unrelated stalls silently. |
| Active response | Scheduling/preparation p95 ≤2ms per responding frame, no synchronous layout read on edit; ≤24 active animations, ≤24 sprite nodes, zero unbounded queue. Trace GPU/compositor activity and repaint area including the glass card. |
| Quiescent/hidden/static | After final ≤320ms response settles: 0 decoration rAF/timer callbacks, 0 active animations, 0 network polls and **0 attributable durable write bytes** in three 60s windows. Hidden/reduced cancels by next frame; no new edit means no restart. |
| Memory/bundle | ≤16MiB incremental steady renderer memory at 2M decoded pixels, ≤32MiB transient import allocation; Off adds no loaded renderer/assets. Lazy renderer JS ≤30KiB gzip excluding art; no generic engine dependency. |
| Theme load/import | Editor ready independently of theme; warm poster display p95 ≤100ms. Max legal pack validate+install p95 ≤500ms on reference desktop, while typing budgets still hold; count every image/sprite and canonical revision after restart. |
| Mutation I/O | ≤64KiB attributable metadata/WAL bytes per selection averaged over 100 changes, including checkpoint; payload assets separately bounded by 8MiB/pack. Preview/keystrokes write 0 feature bytes. No delayed burst excluded from accounting. |

Use the same owner-scale synthetic dataset as feature A: 1.3GB App DB/600+ chats/~300k events, 7GB BTCC, 2,440 transcripts/1.5GB/largest 290MB, >300MB metrics. No access to real owner data and no whole-transcript reads. Add a 200-pack paginated catalog; verify complete ordered enumeration/latest selected revision. Compare Off/static/interactive on 375 and 1280, both themes, external wallpaper on/off, AC/battery/unknown, reduced motion and hidden state.

Instrument aggregated in-memory timing/counters in the disposable harness; do not log keystrokes/content. Report device, OS, browser/build, cold/warm condition and sample size; measure actual GPU/device memory where available, otherwise mark unavailable. Idle whole-process I/O is separate from attributed decoration writes; include original draft persistence costs in the whole-app trace. Synthetic Chromium `--single-process` establishes behavior only, not representative hardware power or smoothness. Physical mobile and desktop energy acceptance remains required before enabling Interactive by default. Power comparison: three matched 5-minute typing runs, incremental average CPU ≤1 percentage point and energy ≤5% over static on the named device; report metric/tool availability and all runs without retry-to-green.

## Phased branches and public acceptance

| Branch / dependency | Scope and acceptance |
|---|---|
| `codex/composer-decoration-static` / A surface contract | B-01: actual Appearance picker → composer poster/Off, light/dark, all text zones disjoint. Include direct raster import → validation → preview → explicit apply → restart persistence and removal; B-04 static/hidden/reduced behavior. The product consumer and DS capability land together. |
| `codex/composer-decoration-reactive` / static | B-02: bundled sway/fall/hop, committed-edit/IME pulse, rapid typing/paste, animation cancellation; connect existing global reduce-motion setting. B-03: battery/unknown/visibility rules through platform boundary if necessary. Meet input/idle/GPU budgets before acceptance. |
| `codex/composer-decoration-packs` / reactive | B-05: full declarative zip imports with all security bounds and precise failure state; user-created interactive pack reaches actual composer. B-06: atomic crash recovery, in-use deletion/concurrency, cursor catalog and all budget/correctness gates. No arbitrary-format fallthrough. |

E2E first in `crates/butler-e2e`, stub/replay: import/apply/read/restart/delete, unauthorized upload and asset access, stale selection, interrupted install, corrupted selected revision; assert exact content hashes/counts and no partial selection. Exercise the actual API/storage, not a mock service. Reuse existing wallpaper import/settings durability coverage if shared helpers change; never only new tests. Parser/zip attacks may use `// test-category: security`; scheduler algebra only `pure-logic`, race cases only `race`, wire schema only `format-pin`, with no source-check count increase.

UI smoke/harness only: extend existing composer caret/refresh, question/decision, DS motion trace and layout smoke to cover B-01–06. Use real component input events and verify text/reference fidelity and keyboard focus, no decoration in accessibility tree or hit testing, no crop/overlap at 8 rows, all sprites inside band, and no loop when idle/hidden. Synthetic composition events check guards; Korean/Japanese native IME remains physical-device proof. Test a valid maximum pack and malicious traversal/symlink/zip-bomb/duplicate-key/SVG/script/URL/animated-image packs; failures must not affect typing or previous theme.

Every test/check uses fresh temp HOME/BUTLER_DATA with cleanup; stub/replay only; Chromium launch requires `--single-process` here. No real owner installation/port 18765, no screenshots/mockups in this task. Future TS/UI branches run frozen Bun install/check and existing focused smokes; Rust changes run fmt, touched-crate clippy `-D warnings` and source-check. Files ≤500 lines/functions ≤80; DS stricter component limits apply. No new UI unit tests, recordings, test ratchet increase, changed timeout or weakened budget.

## Self-review, risks and owner choices

Self-review: built-in + user-imported static/interactive coverage is explicit; text safety is geometric, not opacity-dependent; all six renderers are compared; signal/runtime/persistence/security owners and public acceptance are defined. Reuse is limited to proven seams: DS motion/signals, existing settings/SSE and secure bounded image primitives. No engine or work-model redesign is implied.

Risks: translucent glass may repaint during sprite motion despite compositor-friendly transforms; that needs measurement. Imported art may not suit the narrow band; reject unsupported packs clearly and show the exact preview. Battery/occlusion/global reduce-motion adapters vary by integration/platform; unavailable signals have a defined static fallback. Limits may exclude an artist's complex scene; review that as a future format revision, never silently execute scripts or lower accepted quality.

Real owner choices for Monday: (1) confirm initial **Off** versus a bundled **Static** theme (recommend Off; Interactive explicit opt-in); (2) confirm the reserved top-band interpretation versus wanting characters to protrude above the card (recommend contained band to keep question/approval panels unobstructed). The no-text-overlap, no-script and reduced-motion requirements are fixed, not optional decisions.

Still pending: design-agent mockups, separately authorized implementation, hardware input/GPU/energy measurements, physical mobile/IME verification, and final global reduce-motion integration proof. This design claims none of those have passed.
