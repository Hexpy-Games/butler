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
- The model step opens directly on the App model-add route.
- The first-run model-add route must support hosted models with API key and
  local OpenAI-compatible models.
- The first-run model-add route must not expose OAuth until the Electron UI can
  perform the OAuth login and token registration flow end-to-end.
- Hosted providers that do not support any first-run-allowed authentication
  method must be excluded from first-run provider choices.
- After a model is added during first-run setup, that added model becomes the
  Butler default model before setup can complete.
- After the added model has been saved as the Butler default model, the setup
  completes immediately without requiring a second confirmation button.
- The model step may complete setup only after App settings and model catalog
  are loaded and a registered, runtime-supported model has been saved as the
  default model.
- If the App restarts after the model was registered and saved as default but
  before the final setup confirmation, the model step must allow completion
  without requiring the user to add the same model again.
- If saving the added model as the default model fails, the model step must show
  the failure and offer a retry that repeats the default-model save.
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
- The `TintedGlass` body uses the design-system `ScrollArea` block for bounded
  internal scrolling when model-management content exceeds the visible area.
- The model-add body does not show model-management breadcrumbs during
  first-run setup.

## Validation

- Component tests cover the four-step order, absence of gateway/persona copy,
  bundled-Agent-only installation, model-add-first setup, added-model default
  persistence, automatic completion after add, post-save recovery,
  default-save retry, OAuth hiding, breadcrumb hiding, and no Settings route.
- AppShell first-run tests prove the workspace is gated until the model save
  completes.
- Manual first-run smoke launches an isolated Electron profile and data root so
  it cannot touch the user's normal Butler state.
