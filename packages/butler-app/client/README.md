# Butler App Client

`packages/butler-app/client/` contains the desktop app client surfaces.

## Module Map

- `electron/`: native desktop shell, preload bridge, desktop package metadata,
  and app startup orchestration.
- `ui/`: renderer UI, design system, app state, and browser-compatible app
  screens.

## Boundaries

Client code talks to the agent-owned app gateway through HTTP. It should not
import Butler Agent internals directly.

The UI must remain browser-compatible when served over local or LAN HTTP. Do
not call optional Web Crypto helpers such as `crypto.randomUUID()` directly from
renderer code; use the app ID helpers so message sending, attachment queues, and
settings rows keep working when a browser exposes only `getRandomValues` or no
Web Crypto object.

## Related Specs

- `SPEC-BUTLER-DEDICATED-CLIENT` - Butler Dedicated Client
- `SPEC-BUTLER-DEDICATED-CLIENT-APP-EXPERIENCE` - Butler Dedicated Client App Experience
- `SPEC-BUTLER-DEDICATED-CLIENT-DESIGN-SYSTEM` - Butler Dedicated Client Design System
