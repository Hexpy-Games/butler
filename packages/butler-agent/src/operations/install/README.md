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

## Related Specs

- `SPEC-INSTALLER-UPGRADE-UX` - Installer And Upgrade UX
- `SPEC-MANAGED-BUN-RUNTIME` - Butler-Managed Bun Runtime
- `SPEC-RELEASE-PACKAGING` - Release Packaging
- `SPEC-OPENAI-AUTH-AND-MODELS` - OpenAI Auth And Model Discovery
