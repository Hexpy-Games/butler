# Butler App First-Run Setup

## Scope

Butler App distribution includes Butler Agent. A clean App launch must complete
the App-owned setup flow inside Electron before the workspace is shown.

## Flow

1. Language
2. Safety notice
3. Butler Agent readiness
4. Model setup

## Requirements

- The first screen detects the system language, then lets the user choose
  Korean or English.
- The safety notice must contain enough operational caution to justify its
  presence, without exposing internal gateway or Agent implementation details.
- The App distribution uses the bundled Agent path only. It must not offer an
  existing-Agent connection, gateway selection, curl, unzip, or terminal
  dependency path.
- The installation step uses the title `Butler Agent를 준비합니다`.
- The model step must load runtime-supported model options, save the selected
  default model through App settings, and complete first-run setup from inside
  the wizard.
- The model step must not route the user to the Settings screen during
  first-run setup.

## UI Requirements

- The background must reuse the new-chat animated fluid background.
- The product title and step labels are flat chrome outside the main body.
- Step labels are progress text, not button-like pills.
- The main body uses `TintedGlass`.
- The first-run body must not add card shadows.
- Text hierarchy must stay compact: product label, step title, body copy,
  secondary status.

## Validation

- Component tests cover the four-step order, absence of gateway/persona copy,
  bundled-Agent-only installation, internal model save, and no Settings route.
- AppShell first-run tests prove the workspace is gated until the model save
  completes.
- Manual first-run smoke launches an isolated Electron profile and data root so
  it cannot touch the user's normal Butler state.
