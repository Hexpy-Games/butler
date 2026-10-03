#!/usr/bin/env bash
# Published baseline -> exact candidate using the product Settings update action.
set -euo pipefail
[[ "$BASELINE_TAG" =~ ^v0\.1\.0-preview\.[0-9]+$ ]]
[[ "$CANDIDATE_VERSION" =~ ^0\.1\.0-preview\.[0-9]+$ ]]
profile="$(mktemp -d)"
export HOME="$profile/home" BUTLER_DATA="$profile/data"
mkdir -p "$HOME" "$BUTLER_DATA" "$profile/baseline" "$profile/candidate"
trap 'rm -rf "$profile"' EXIT
gh release download "$BASELINE_TAG" --dir "$profile/baseline" \
  --pattern '*-darwin-arm64.zip' --pattern '*-darwin-arm64.zip.sha256'
if [ "$PUBLISHED_CANDIDATE" = true ]; then
  gh release download "v$CANDIDATE_VERSION" --dir "$profile/candidate" \
    --pattern '*-darwin-arm64.zip' --pattern '*-darwin-arm64.zip.sha256'
  export BUTLER_UPDATE_SMOKE_MANIFEST="https://github.com/$GITHUB_REPOSITORY/releases/download/v$CANDIDATE_VERSION/app-update-manifest.json"
else
  cp "dist/release/app/butler-app-$CANDIDATE_VERSION-darwin-arm64.zip" \
    "dist/release/app/butler-app-$CANDIDATE_VERSION-darwin-arm64.zip.sha256" "$profile/candidate/"
fi
for part in baseline candidate; do
  archive=("$profile/$part/"*.zip)
  test "${#archive[@]}" -eq 1
  (cd "$profile/$part" && shasum -a 256 -c "$(basename "${archive[0]}").sha256")
  ditto -x -k "${archive[0]}" "$profile/$part/unpacked"
done
export BUTLER_UPDATE_SMOKE_FROM="${BASELINE_TAG#v}" BUTLER_UPDATE_SMOKE_TO="$CANDIDATE_VERSION"
export BUTLER_UPDATE_SMOKE_FROM_BUNDLE="$profile/baseline/unpacked/Butler.app"
export BUTLER_UPDATE_SMOKE_TO_BUNDLE="$profile/candidate/unpacked/Butler.app"
bun run app:update:smoke
