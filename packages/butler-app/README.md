# Butler App

`packages/butler-app/` contains the recommended desktop product. Butler App is
the Electron shell, renderer UI, bundled-Agent lifecycle surface, and app-owned
tooling; the HTTP app gateway is owned and run by Butler Agent. In development,
`bun run app:client:dev` starts only the Electron/Vite client and connects to
the already running agent gateway.

## Module Map

- `client/electron/`: desktop shell, preload bridge, app packaging metadata,
  and Electron-only local integration.
- `client/ui/`: React/Vite renderer, app state, design system, and app-facing
  API calls.
- `scripts/`: deterministic app development, HMR, release, and client quality
  checks.

## Boundaries

The app may call a configured local app gateway URL. It must not own or import
agent turn execution, cognition, scheduler, worker runtime, gateway session
actors, or agent policy.

The renderer copy follows the app settings language returned by the gateway.
Installer language initializes both the app interface language and the agent
response language, so a fresh English install must render English UI copy after
settings load. The model catalog default returned by the gateway must also
reflect the installed Butler model, including `local/<id>` models registered
during install.

## Worker Timeline Check

Use the Electron app when validating that a delegated worker turn exposes a
visible worker timeline, not only persisted task files.

1. Start the app against the local Agent gateway:
   `bun run app:client:dev`. The script starts Vite for `client/ui`, launches
   the Electron shell from `client/electron`, and points it at the configured
   local app gateway with `BUTLER_APP_SERVER_URL` / `BUTLER_APP_UI_URL`.
2. In the Electron window, send a normal request that exercises the current
   BTCC path. Do not use the retired local SessionActor harness as product
   evidence.
3. While the worker runs, inspect the assistant turn's work/turn activity area
   in the conversation view. The worker activity panel should show timeline
   rows for the worker, including executing and verifying phases plus
   implementation evidence such as an edit/write action.
4. If the timeline is missing or stale, check the app gateway process output
   and the Electron/Vite terminal output from `app:client:dev`, then confirm
   worker state through the app inspector/workers surface before treating it as
   a UI projection issue.
5. If the Electron app cannot be automated in the current environment, record
   the exact launch command, the prompt used, and whether the activity panel
   showed the worker timeline before reporting the check as manual.

## Related Specs

- `SPEC-BUTLER-DEDICATED-CLIENT` - Butler Dedicated Client
- `SPEC-BUTLER-DEDICATED-CLIENT-APP-EXPERIENCE` - Butler Dedicated Client App Experience
- `SPEC-BUTLER-DEDICATED-CLIENT-PROTOCOL` - Butler Dedicated Client App Protocol
- `SPEC-BUTLER-DEDICATED-CLIENT-DESIGN-SYSTEM` - Butler Dedicated Client Design System
