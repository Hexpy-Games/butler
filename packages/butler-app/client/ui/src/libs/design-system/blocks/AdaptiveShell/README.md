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

- Expanded layouts use resizable grid tracks.
- Medium layouts use bounded overlay panels.
- Compact layouts use an 88vw left drawer and full-cover right sheet.
- Panels animate with transform and honor reduced motion.
- The always-mounted scrim keeps a promoted compositor layer and animates only
  opacity, preventing repeated mobile panel toggles from flashing.
- The workspace remains full width in compact and medium modes.

## Wrong use cases

Do not fetch domain data, import app stores, or add product selectors to this
block. Do not use it as a generic card or nested panel.

## Tags

shell, drawer, inspector, responsive, adaptive, motion
