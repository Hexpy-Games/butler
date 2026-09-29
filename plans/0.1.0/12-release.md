# 12. Release v0.1.0 (final)

**Preconditions:**
- Plans 01–10 are merged.
- #300 and #303 are on main, because the current updater selects darwin-only artifacts.
- Main CI is green.

## Steps
1. **Versions.** Bump every package that must agree: `crates/butler-agent/Cargo.toml`, the npm package `packages/butler-npm`, and the App version. The release gate fails if the tag doesn't equal the Agent version.
2. **Release notes.** Write `.github/releases/v0.1.0.md`. Remove the stale claims left over from v0.0.21, such as required DEB/Arch/Windows assets.
3. **Owner confirmation.** The owner must explicitly confirm before the tag is pushed. Only repository admins can create `v*` tags (ruleset).
   - Suggested path: first push `v0.1.0-preview.1`. It publishes as a prerelease, and npm puts it under dist-tag `next`.
   - Verify that prerelease, then push `v0.1.0`.
4. **Verify the published release.**
   - Draft handling: the release stays a draft until all assets exist, and `npm publish` runs only after `publish-release`.
   - Mac, from a clean Mac, downloading through a browser so the files are quarantined:
     - `spctl -a -vv -t open --context context:primary-signature <dmg>`
     - `xcrun stapler validate <dmg>`
     - `codesign --verify --strict --deep -vv /Applications/Butler.app`
     - First launch works. If it crashes at JIT, add back `allow-unsigned-executable-memory` in `deploy/macos/electron.entitlements.plist`.
   - Agent: `codesign --verify -R='=notarized' --check-notarization butler-agent`, and `binarySha256` matches.
   - Linux: `curl -fsSL https://github.com/Hexpy-Games/butler/releases/latest/download/install.sh | sh` works on Ubuntu. The DEB installs.
   - npm: `npx @hexpygames/butler install` works.
5. **Docs.** Merge README #251. Update the site's install page to cover Linux packages, the one-liner and npx.

## Rollback
- Delete the GitHub release, or turn it back into a draft.
- `npm deprecate` the version.
- The Mac updater keeps the previous `latest`.
