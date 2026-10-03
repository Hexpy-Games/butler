#!/usr/bin/env bash
# Published baseline -> exact candidate using the product Settings update action.
set -euo pipefail
[[ "$BASELINE_TAG" =~ ^v0\.1\.0-preview\.[0-9]+$ ]]
[[ "$CANDIDATE_VERSION" =~ ^0\.1\.0-preview\.[0-9]+$ ]]
test "$PUBLISHED_CANDIDATE" = true
profile="$(mktemp -d)"
export HOME="$profile/home" BUTLER_DATA="$profile/data"
mkdir -p "$HOME" "$BUTLER_DATA" "$profile/baseline" "$profile/candidate"
baseline_mounted=false
cleanup() {
  if [ "$baseline_mounted" = true ]; then
    hdiutil detach "$profile/baseline/mount"
  fi
  chmod -R u+w "$profile"
  rm -rf "$profile"
}
trap cleanup EXIT
gh release download "$BASELINE_TAG" --dir "$profile/baseline" \
  --pattern '*-darwin-arm64.dmg' --pattern '*-darwin-arm64.dmg.sha256'
# The released DMG is the installation artifact; ZIP is the updater payload.
# ZIP does not retain the role hard links required by the installed App.
baseline=("$profile/baseline/"*.dmg)
test "${#baseline[@]}" -eq 1
(cd "$profile/baseline" && shasum -a 256 -c "$(basename "${baseline[0]}").sha256")
mkdir -p "$profile/baseline/mount" "$profile/baseline/unpacked"
hdiutil attach -readonly -nobrowse -mountpoint "$profile/baseline/mount" "${baseline[0]}"
baseline_mounted=true
ditto "$profile/baseline/mount/Butler.app" "$profile/baseline/unpacked/Butler.app"
hdiutil detach "$profile/baseline/mount"
baseline_mounted=false
gh release download "v$CANDIDATE_VERSION" --dir "$profile/candidate" \
  --pattern '*-darwin-arm64.zip' --pattern '*-darwin-arm64.zip.sha256'
export BUTLER_UPDATE_SMOKE_MANIFEST="https://github.com/$GITHUB_REPOSITORY/releases/download/v$CANDIDATE_VERSION/app-update-manifest.json"
archive=("$profile/candidate/"*.zip)
test "${#archive[@]}" -eq 1
(cd "$profile/candidate" && shasum -a 256 -c "$(basename "${archive[0]}").sha256")
ditto -x -k "${archive[0]}" "$profile/candidate/unpacked"
export BUTLER_UPDATE_SMOKE_FROM="${BASELINE_TAG#v}" BUTLER_UPDATE_SMOKE_TO="$CANDIDATE_VERSION"
export BUTLER_UPDATE_SMOKE_FROM_BUNDLE="$profile/baseline/unpacked/Butler.app"
export BUTLER_UPDATE_SMOKE_TO_BUNDLE="$profile/candidate/unpacked/Butler.app"
bun run app:update:smoke
