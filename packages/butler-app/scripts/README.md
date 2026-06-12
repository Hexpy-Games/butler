# Butler App Scripts

`packages/butler-app/scripts/` contains app-owned development, HMR, release,
and client-only quality checks. Development launches only the Electron client
and Vite renderer; the local HTTP app gateway is agent-owned and must already
be reachable through `BUTLER_APP_SERVER_URL` or `BUTLER_APP_SERVER_PORT`. The
agent gateway allows the default Vite origin `http://127.0.0.1:5173` so the
dev renderer can attach without starting a second app-server.

## Key Areas

- Client development: `app-client-dev.ts`.
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
