# Official Butler loading spinner

## Accepted intent

On 2026-09-10 the user selected candidate 2, **이동하는 절개** (traveling gap), from the second spinner mockup and requested an official design-system component replacing every product spinner.

Approved reference: `butler-spinner-candidates-v2.html`, candidate 2. The visual contract is a flat, monochrome open circle: 79% of the circumference is drawn, with rounded ends and a stable center. One revolution takes 1320ms; angular position follows `2πu − 0.43 sin(2πu) − π/2`. Radius is 36.5% of the icon box, and stroke is `max(1.35px, 7.1% of size)`.

## Scope and public path

The DS owns rendering, sizing, timing, and reduced-motion behavior through `Spinner`, exported from `@/butler-ds`. Product owners continue to choose when their current state needs a spinner and when to remove it. No service, runtime, provider, persistence, or account behavior changes.

Current consumers to migrate:
1. `SpaceActivity`: production sidebar activity and menu overlays.
2. `SpaceSessionStatus`: the existing sidebar prototype.
3. `ProjectBoardCard`: running session shortcut.
4. `SummaryPanel`: running progress rows.
5. `TodoProgressItemRow`: running/reviewing items.
6. `ComposerSendButton`: connection/busy state.

Remove the old `LoaderCircle` DS icon export and the four feature-owned rotation styles. Preserve the existing Butler agent activity mark, worker pulse, skeleton placeholders, and determinate progress/context gauges: these are distinct state displays, not spinners.

## Observable acceptance

- All six consumers render the same DS spinner with their existing sizes, labels, disabled states, and state conditions.
- Geometry and cycle match the approved candidate. CSS interpolates sampled points of the approved angular function, without a JavaScript frame loop or component-local timers.
- Color inherits `currentColor`, including inverse buttons and both themes. Rotation is internal so parent icon transforms do not overwrite it.
- Reduced motion shows a static open ring. A visible label/parent status names the work. A standalone spinner may receive a localized `label`; otherwise it is decorative.
- The caller owns completion, failure, and cancellation. Removing a spinner must not delay an existing result or imply every terminal state is successful. The mockup's success button was a preview interaction, not a new mandatory product state machine.
- DS Viewer lists Spinner with its own fixture and usage README. The old loader and independent spinner definitions are absent.
- Validate the DS component at desktop and 320/375/390/430px; verify actual sidebar and reconnecting composer paths, reduced motion, and the current UI static gates.

## Plan and review

- [x] Inventory consumers and review scope/spec. Six concrete call sites and no new state ownership; ready to implement.
- [x] Add DS primitive, docs, fixture, and registry; migrate consumers and remove obsolete ownership.
- [x] Review whole diff against the accepted geometry and product state behavior.
- [x] Run focused tests, UI gates, rendered fixtures, and product smokes; record bounded results below.
- [x] Commit the completed change with this review record.

The DS directory and existing public barrel remain authoritative. No new parallel loading framework or compatibility alias is needed.

## Implementation review and evidence

The six consumers now use the public DS primitive. The old icon export and four local rotation rules are removed. A repository-wide UI source search found no remaining `LoaderCircle`, `Loading03Icon`, dashed-circle spinner, `animate-spin`, or independent spinner keyframes. Agent activity, skeleton shimmer, worker pulse, and the determinate context donut retain their existing owners.

The primitive contains no application state, timer, or external dependency. Busy/terminal state selection and existing accessible names remain at the consumers. The default icon is decorative; a supplied label creates a named status. Geometry matches the accepted reference. Four-decimal CSS easing samples differ from the approved angular function by at most 0.476 degrees across a 100,001-point numerical check.

Validation on 2026-09-10:

| Check | Result |
| --- | --- |
| Spinner accessibility and actual composer send/stop/busy semantics | 2 tests passed, 14 assertions |
| UI TypeScript, targeted ESLint (15 files), design lint, CSS lint, diff whitespace | Passed |
| Module-shape audit on the primitive and consumers | 10 source files, no review signals |
| Production build and DS Viewer Spinner render | Passed at 1440/430/390/375/320px |
| Browser motion and theme inspection | Both themes at five widths; inherited color, changing rotation, seamless cycle, static reduced motion, and caller-owned removal passed |
| Actual SSE disconnect/recovery through composer hooks and toolbar | Passed at five widths; disabled/non-submit behavior, guarded Enter, and draft preservation retained |
| Actual HTTP message through test app server and live product sidebar | Passed at five widths; spinner appears during the held response and disappears after completion without reload; reduced motion remains static |

Browser checks use Chromium and isolated test data, with a fixture responder for the sidebar. They do not invoke a model provider or modify production data. Local scripts, motion samples, and screenshots are under `.tmp/spinner-ds`; DS renders are under `.tmp/ds-viewer`, and reconnect screenshots are under `/tmp/live-recovery-browser`.

## Existing validation residuals

- `tests/unit/app-client-design.test.ts`: 33 pass / 12 fail on both the candidate and untouched baseline `88aa3c75` in a temporary checkout. The failing test names match exactly; these existing source-contract failures were not changed for this feature. Comparison is recorded in `.tmp/spinner-ds/design-baseline-comparison.json`.
- `sidebar-r5-layout-smoke.ts`: both candidate and independently built baseline stop at `sidebar-sticky-clipping.ts:38`, “fixture must exercise a pinned branch,” before the spinner assertions. The separate sidebar check above exercised the actual message-to-spinner-to-completion path successfully.
- The ComposerCard DS render captures an empty background, so it is not used as visual evidence for the busy button. The real reconnecting composer was instead inspected at desktop and mobile widths. The TodoProgressPanel render shows the shared spinner in its running row.
- Project Ledger check reports three `stale_view` warnings for generated dashboard, handoff, and roadmap views, with zero record errors. No Ledger records or generated views were changed by this UI task.
- Native packaged Electron and Safari were not exercised. The implementation uses the existing web UI build and shared CSS motion.

The approved spinner replacement is complete. The unrelated baseline checks above remain explicitly unresolved.
