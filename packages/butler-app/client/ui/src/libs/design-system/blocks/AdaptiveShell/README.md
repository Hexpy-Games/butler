# AdaptiveShell

## What it is

`AdaptiveShell` is the domain-neutral Butler application shell presenter. It
owns expanded grid layout and compact/medium transform-based navigation and
inspector panels without reducing compact workspace width.

## Use

Compose `AdaptiveShellSidebar`, `AdaptiveShellWorkspace`,
`AdaptiveShellInspector`, `AdaptiveShellScrim`, and `AdaptivePanelTitlebar` at
the App shell boundary. Product containers own route data and the mutually
exclusive open-panel state.

## Responsive behavior

- Expanded layouts use resizable grid tracks. Tracks never interpolate: the
  docked sidebar slides with a transform while the workspace is
  FLIP-translated (and clipped) in step. Closing collapses the track at once;
  opening keeps the collapsed track until the slide ends, so the workspace
  reflows once. Reduced motion commits at once and the sidebar only fades.
  The docked right inspector uses the same model
  (`useInspectorTrackMotion`): it keeps its full width at the right edge and
  slides with a transform; opening keeps the 0px right track while the panel
  slides in over the workspace (clipped in step) and commits the track when
  the slide ends; closing commits the 0px track at once and the panel slides
  out. In the medium drawer layout the workspace width follows the committed
  track after the push, never a width transition.
- The workspace is an inline-size query container. Product resize geometry may
  retain a 320px workspace and give the inspector all remaining width; the shell
  accepts the measured widths and a standard root ref without owning preferences.
- Browser widths up to 1023px use one push drawer behavior, including medium.
- Electron widths above 640px retain docked grid tracks; only compact uses a drawer.
- The shared `adaptiveDrawerQuery` drives both the shell and panel-state policy.
- Drawers push the full-width workspace, with a full-cover right sheet in compact.
- Pass `compactSidebarFullWidth` for navigation that should fully cover the
  compact (`width <= 640px`) drawer viewport. Medium drawer widths always use
  the bounded `--adaptive-drawer-width` (`min(88vw, 320px)`) over the scrim so
  the workspace stays visible beside the sidebar.
- The window chrome toggle stays fixed while the workspace moves.
- Panels animate with transform and honor reduced motion.
- The always-mounted scrim keeps a promoted compositor layer and animates only
  opacity, preventing repeated mobile panel toggles from flashing.
- The workspace remains full width in compact and medium modes.

## Wrong use cases

Do not fetch domain data, import app stores, or add product selectors to this
block. Do not use it as a generic card or nested panel.

## Tags

shell, drawer, inspector, responsive, adaptive, motion
