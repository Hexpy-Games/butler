# Butler App First-Run Setup

## Scope

Butler App distribution includes Butler Agent. A clean App launch must complete
the App-owned setup flow inside Electron before the workspace is shown.

The long-term App distribution target is defined in
`background-service-distribution.md`: first-run should install or verify the
background Butler Agent service, not rely on a production Electron-owned child
Agent process.

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
- The Agent readiness step must check the Electron main service-control bridge
  before managed gateway readiness. If the background service is not installed,
  stopped, or requires permission, the setup bridge attempts service
  install/start through service-control.
- If service registration is unavailable or fails, first-run must stop at the
  install step with redacted diagnostics. It must not silently fall back to an
  Electron-owned child gateway in production App distribution.
- In the current migration phase, service-control is a required gate before the
  existing managed gateway readiness check. Packaged macOS/Linux builds wire
  service-control to the native service bridge; development and unsupported
  platforms fail closed without registering host services. In packaged
  native-service mode, readiness verifies the service-owned gateway health and
  protocol directly and must not spawn an Electron-owned child gateway as a
  fallback.
- The installation step uses the title `Butler Agent를 준비합니다`.
- The model step must reuse the App settings model-management modules instead
  of implementing a separate one-off model picker.
- The model step opens directly on the App model-add route.
- The first-run model-add route must support hosted models with API key,
  OpenAI Codex OAuth, and local OpenAI-compatible models.
- OpenAI Codex OAuth must follow the same install-time behavior as
  `install.sh`: use the app's isolated `BUTLER_DATA`, detect an existing
  Codex auth profile, otherwise launch the OAuth login helper, then register
  the selected model with `auth_type: "codex_oauth"`.
- In App-managed installs, OpenAI Codex OAuth must resolve the login helper and
  Bun runtime from the active App-managed Agent pointer under the isolated
  `BUTLER_DATA` before falling back to development checkout paths.
- During OpenAI Codex OAuth, the first-run UI must keep recovery controls on
  screen: show the OAuth URL, allow copying/opening it, automatically check
  completion after the browser finishes authentication, allow a manual
  `인증 완료 확인` action, and allow re-authentication when the browser window is
  closed or the prior login session fails.
- The OAuth recovery UI must not make callback/result URL paste the primary
  path. The browser success screen asks the user to close the window, so the
  App UI should ask the user to return to Butler and confirm completion.
- Selecting OpenAI Codex OAuth during first-run model setup starts a recoverable
  OAuth login session immediately, before the user presses the model-add
  button.
- If an internal fallback submits a pasted OAuth callback/result URL, it must be
  accepted only for the active pending OAuth session by matching the active
  redirect URI and OAuth state, and the App must wait for the helper to finish
  writing the auth profile before it reports completion.
- Hosted providers that do not support any available authentication method must
  be excluded from provider choices.
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
  default-save retry, OAuth login/registration, immediate OAuth session start,
  automatic/manual OAuth completion checks, OAuth pending recovery controls,
  breadcrumb hiding, and no Settings route.
- Electron OAuth helper tests prove packaged App-managed installs resolve the
  helper and runtime from the active App-managed Agent pointer.
- Electron setup bridge tests prove the install step calls service-control
  before managed gateway readiness and fails closed when registration is
  unavailable.
- AppShell first-run tests prove the workspace is gated until the model save
  completes.
- Manual first-run smoke launches an isolated Electron profile and data root so
  it cannot touch the user's normal Butler state.
