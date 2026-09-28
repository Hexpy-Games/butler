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

## Running `app:client:dev` Against a Gateway

`bun run app:client:dev` serves the renderer from Vite
(`http://127.0.0.1:5173` by default, `BUTLER_APP_UI_PORT` / `BUTLER_APP_UI_URL`
override it) and talks to an already running gateway
(`BUTLER_APP_SERVER_URL`, default `http://127.0.0.1:18765`). The gateway
checks every request:

- **Origin allowlist.** The gateway answers browser origins `app://butler`
  (the packaged App), its own `http://<loopback>:<port>`, and the exact origins
  listed in `BUTLER_APP_DEV_ORIGIN` (comma-separated, compared as raw strings:
  no trailing slash, no path). There is no loopback dev-origin default, and
  `Origin: null` is always refused. A Vite renderer on another port therefore
  needs the **gateway** started with `BUTLER_APP_DEV_ORIGIN=<vite origin>`;
  otherwise every renderer request fails with `403 origin_not_allowed`. Setting
  the variable only for Electron is not enough: it is read by the process that
  serves the gateway.
- **Local auth is always on.** The gateway keeps its bearer token in
  `$BUTLER_DATA/app/runtime/auth/local-agent-auth.json`
  (`BUTLER_APP_LOCAL_AUTH_FILE` overrides it). Electron reads the same file from
  its `BUTLER_DATA`, so run the client with the gateway's data folder.
  `app:client:dev` reads the token to wait for `/health`, then checks the Vite
  origin against the gateway and stops with the exact `BUTLER_APP_DEV_ORIGIN`
  to set when it is refused.
- **Message files.** JSON that carries `"url": "/message-files/<id>"` also
  carries a `"signed_url"` (valid 10 minutes) for `<img>` and download links,
  which cannot send the bearer header.
- **Public files.** Only UI bundle files (`/assets/...` and root-level
  js/css/svg/json/woff2) are served without a credential. A plain browser tab
  on the gateway gets a session from a one-time link: `butler open`.

Example against an installed service on the default ports:

```sh
# Restart the gateway with the Vite origin allowed (the variable must be in the
# environment of the command that starts the service).
~/Applications/ButlerAgent/<version>/butler-agent stop --data ~/.butler
BUTLER_APP_DEV_ORIGIN=http://127.0.0.1:5173 \
  ~/Applications/ButlerAgent/<version>/butler-agent start --data ~/.butler

# Then start the dev client with the same data folder.
BUTLER_DATA=~/.butler bun run app:client:dev
```

Repeat the stop/start after the installed service is updated: an update
restarts the service without this development-only variable.

Smokes start their own isolated gateway through
`tests/support/native-app-server.ts`, which reads the token from its temporary
`BUTLER_DATA`, signs pages in with a connection code (`signIn`), and passes
`devOrigins` as `BUTLER_APP_DEV_ORIGIN` when a smoke serves the UI from another
origin (the Electron smokes' proxy).

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
