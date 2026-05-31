# Butler App

`packages/butler-app/` contains the optional desktop app product. Butler App is
the Electron shell, renderer UI, and app-owned tooling; the HTTP app gateway is
owned and run by Butler Agent. In development, `bun run app:client:dev` starts
only the Electron/Vite client and connects to the already running agent gateway.

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

## Related Specs

- `SPEC-BUTLER-DEDICATED-CLIENT` - Butler Dedicated Client
- `SPEC-BUTLER-DEDICATED-CLIENT-APP-EXPERIENCE` - Butler Dedicated Client App Experience
- `SPEC-BUTLER-DEDICATED-CLIENT-PROTOCOL` - Butler Dedicated Client App Protocol
- `SPEC-BUTLER-DEDICATED-CLIENT-DESIGN-SYSTEM` - Butler Dedicated Client Design System
