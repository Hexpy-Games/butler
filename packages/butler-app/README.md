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

## Related Specs

- `SPEC-BUTLER-DEDICATED-CLIENT` - Butler Dedicated Client
- `SPEC-BUTLER-DEDICATED-CLIENT-APP-EXPERIENCE` - Butler Dedicated Client App Experience
- `SPEC-BUTLER-DEDICATED-CLIENT-PROTOCOL` - Butler Dedicated Client App Protocol
- `SPEC-BUTLER-DEDICATED-CLIENT-DESIGN-SYSTEM` - Butler Dedicated Client Design System
