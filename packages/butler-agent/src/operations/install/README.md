# install

`packages/butler-agent/src/operations/install/` contains TypeScript helpers for installer and upgrade flows.
Shell entrypoints can delegate here when the behavior needs structured parsing,
state migration, or testable upgrade reports.

## Key Files

- `upgrade.ts`: config migration, upgrade report, rollback target, and private
  state preservation helpers.

## Boundaries

Installer code may read and write private config under `BUTLER_DATA`, but it
must not move private data into the git checkout. Runtime repair should preserve
an existing working managed runtime when a new download fails.

## Installer UX Contract

- Fresh installs must not ask for profile learning consent in the installer.
  The installer initializes profiling as `off` and prepares first-chat
  onboarding; first-chat onboarding owns the consent question and the product
  profiling choices: `off`, `basic`, and `deep`.
- Public user installs consume tag release artifacts, not source checkouts.
  `install.sh` runs from the extracted service package and must not build
  `packages/butler-app/client/ui`; CI/tag release packaging owns the app web
  client build.
- The installer language is also the initial agent response language. Fresh
  installs must write `user.language` for UI/default locale context and
  `user.responseLanguage` for model-facing assistant replies, both as `en` or
  `ko`, before first-chat onboarding starts.
- Local model setup must never dead-end on a single unreachable server URL.
  When discovery cannot return a model and no model id was provided, interactive
  installs must let the operator retry with another URL or enter a model id
  manually.
- A completed install must leave the product CLI available as a native
  executable named `butler` from the installed shell environment. The shell
  environment must add `$BUTLER_DATA/bin` to `PATH`; release artifacts include
  prebuilt CLI launchers that the installer copies into `$BUTLER_DATA/bin`.
  Source-checkout installs may build the launcher as a fallback. `bin/butler.js`
  remains an internal entrypoint only.
- The interactive Docker installer must run from a service release artifact,
  keep the container open after a completed install, and publish the Butler App
  gateway to the host for browser/health checks. The container app gateway binds
  to `0.0.0.0:18765`; the host port must avoid the normal host Butler port and
  defaults to the first free port starting at `127.0.0.1:18766`. The Docker
  harness must verify that the service artifact contains the built app web
  client and that `/` serves HTML, not an API `not_found` envelope.

## Related Specs

- `SPEC-INSTALLER-UPGRADE-UX` - Installer And Upgrade UX
- `SPEC-MANAGED-BUN-RUNTIME` - Butler-Managed Bun Runtime
- `SPEC-RELEASE-PACKAGING` - Release Packaging
- `SPEC-OPENAI-AUTH-AND-MODELS` - OpenAI Auth And Model Discovery
