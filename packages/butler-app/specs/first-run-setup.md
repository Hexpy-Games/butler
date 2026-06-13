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
- The model step must reuse the App settings model-management modules instead
  of implementing a separate one-off model picker.
- The model step must let the user choose the Butler default model, open model
  management, register hosted models with API key or OAuth, and add local
  OpenAI-compatible models.
- The model step may complete setup only after App settings and model catalog
  are loaded and at least one runtime-supported model is available.
- The model step must not route the user to the Settings screen during
  first-run setup.

## UI Requirements

- The background must reuse the new-chat animated fluid background.
- The product title and step labels are flat chrome outside the main body.
- Step labels are progress text, not button-like pills.
- The main body uses `TintedGlass`.
- The first-run body must not add card shadows.
- The setup shell remains centered in the viewport.
- The product title uses the new-chat title scale so `Butler` anchors the
  screen more strongly than the active step title.
- Only the content inside the `TintedGlass` body aligns from the top-left.
- The `TintedGlass` body has a bounded height and scrolls internally when
  model-management content exceeds the visible area.

## Validation

- Component tests cover the four-step order, absence of gateway/persona copy,
  bundled-Agent-only installation, settings-module model setup, model
  management/add routes, and no Settings route.
- AppShell first-run tests prove the workspace is gated until the model save
  completes.
- Manual first-run smoke launches an isolated Electron profile and data root so
  it cannot touch the user's normal Butler state.
