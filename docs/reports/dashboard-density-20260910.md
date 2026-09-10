# Comparative dashboard layout

## Scope and result

Spec: `SPEC-DASHBOARD-DENSITY-20260910`; task: `T-DASHBOARD-DENSITY-20260910`.
The existing dashboard now uses one centered, 72rem maximum content container.
At 48rem of actual available content width, related statistics sit side by side;
narrow content regions return to one column without changing reading order.
This uses a container query, not a desktop-window assumption.

- Overview: project context first; up to four remaining-work cards beside four
  important materials, with a 2:1 section ratio. Full lists remain reachable.
  Up to three next-action suggestions use separate cards below.
- Statistics: work flow/distribution, activity/focus, and outcomes/duration are
  paired. Aging work uses compact cards; long material timelines retain width.
- ActivityHeatmap remains the shared DS component. Seven weekday rows and week
  columns replace the large calendar. A 24px target contains a 16px square.
  Fixed density bands are 0, 1, 2–4, 5–9, and 10+ recorded events; missing history
  is dashed, not zero. Selecting a date keeps the existing source drilldown.
- Existing metrics, status interpretation, filters, localization, and overlay
  composer are preserved. This does not measure productivity or project percent.

## Review and verification

Reviewed the production component diff against the approved reading order and
existing DS contracts. Materials remain visible even when overview data is
unavailable. Work titles retain primary text hierarchy. No parallel data store,
new endpoint, provider invocation, polling, or runtime restart was introduced.

- Real-data browser inspection uses the actual ProjectDashboardView and local
  read-only API in an isolated browser. The preview blocks project mutations;
  it does not send messages or start a briefing generation.
- Desktop 1440px, a 700px dashboard inside a 1440px window, and 430/390/375/320px:
  overview/statistics column geometry, page overflow, and date selection checked.
- Shared DS renderer ran at desktop and 320/375/390/430px, but its element-crop
  images were blank. Direct desktop/320px DS Viewer inspection is used instead,
  with actual 90-day cells. Real dashboard keyboard selection is checked by the
  browser smoke. Unit tests exercise
  density thresholds, missing versus zero, week padding, and selected semantics.
- All 17 statistics/signpost/heatmap tests pass. TypeScript, design/CSS lint,
  and UI build pass; ESLint has zero errors and 238 existing warnings.
- Real 90-day query, inner scroll, and keyboard selection passed after allowing
  the existing API more time. The first API request exceeded the smoke's 30s
  request limit; a later repeated long-range run also timed out. Query performance
  is a separate, unchanged backend residual. Set `DASHBOARD_LONG_RANGE=1` to
  include that slower live API check; it is not the default layout smoke.
- The broad legacy `app-client-design.test.ts` still has the same 12 failures as
  `/tmp/dashboard-r5-final-design-test.log`; none is added by this slice. Its
  source-shape assertions are not represented as a passing acceptance gate.

Screenshots and geometry evidence: `/tmp/dashboard-density/` (local user data,
not committed). DS images: `.tmp/ds-viewer/`.
The browser preview does not validate native Electron window chrome, live
composer model selection, or provider execution; these paths are unchanged.
