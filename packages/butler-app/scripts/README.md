# Butler App Scripts

`packages/butler-app/scripts/` contains app-owned development, HMR, release,
and client-only quality checks. `bun run dev:butler` is the one-command local
development path: it starts the existing Agent-owned app gateway, waits for
its `/health` endpoint, and then starts the existing `app:client:dev` Vite and
Electron path.

The command uses the absolute repository-local `.dev-butler` data root by
default, separate development ports (`28765` for the gateway and `25173` for
Vite), and `.dev-butler/app/electron-user-data` for the Electron profile. It
prints the selected data root and URLs before startup and keeps the data root
when the run stops. Deliberate overrides are supported through
`BUTLER_DEV_DATA`, `BUTLER_DEV_SERVER_PORT`, and `BUTLER_DEV_UI_PORT`. The
runner intentionally does not inherit the corresponding normal Butler runtime
variables; it maps only these explicit development overrides into the child
processes. Gateway/UI hosts remain loopback-only, and the Electron profile
always stays under the selected development data root.

The runner owns the gateway and client children it starts. Ctrl-C, termination,
readiness failure, or either child exiting settles the other child; it does not
delete `.dev-butler`. It uses direct Node/Bun child-process APIs, with POSIX
process groups and attached Windows children, and does not start a second
gateway or Electron runtime.

## Key Areas

- Client development: `app-client-dev.ts`.
- Manual first-run testing: `app-first-run-test-env.ts` launches Electron with
  a clean Butler data root, isolated Electron profile, and local managed
  app-server port so the App setup path can be inspected without touching the
  user's real `~/.butler` state. This is a clean-launch inspection harness; it
  does not prove the first-run setup wizard is implemented.
- App smoke and E2E: `app-client-managed-server-smoke.ts` and
  `app-ui-hmr-smoke.ts` stay here when they are client-owned. Package, layout,
  design-system, render, model-management, and multi-turn checks live under
  `tests/` because they start or inspect the agent-owned app gateway.
- App release: `release/manifest.ts`, `release/release-gate.ts`, and
  `release/package-app-release.ts` validate and package app artifacts without
  depending on service release internals.
- UI quality: `lint/`.

## Boundaries

These scripts validate the Butler App product. Agent runtime validation stays
under `packages/butler-agent/`; repo-wide `tools/` should only hold
package-neutral orchestration.

## Related Specs

- `SPEC-BUTLER-DEDICATED-CLIENT` - Butler Dedicated Client
- `SPEC-BUTLER-DEDICATED-CLIENT-APP-EXPERIENCE` - Butler Dedicated Client App Experience
- `SPEC-BUTLER-DEDICATED-CLIENT-DESIGN-SYSTEM` - Butler Dedicated Client Design System
- `SPEC-RELEASE-PACKAGING` - Release Packaging
