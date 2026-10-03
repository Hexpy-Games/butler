#!/usr/bin/env bash
# Publish only the App artifacts selected by the release workflow.
set -euo pipefail
task_home="$(mktemp -d)"
task_data="$(mktemp -d)"
export HOME="$task_home" BUTLER_DATA="$task_data"
trap 'rm -rf "$task_home" "$task_data"' EXIT
case "${1:-}" in
  linux)
    # Archive names retain the exact release tag version.
    version="${GITHUB_REF_NAME#v}"
    cd dist/release/app-linux
    shopt -s nullglob
    files=(butler-app-*.deb butler-app-*.pkg.tar.zst)
    test "${#files[@]}" -gt 0
    for file in "${files[@]}"; do sha256sum -c "$file.sha256"; done
    gh release upload "$GITHUB_REF_NAME" "${files[@]}" "${files[@]/%/.sha256}" --clobber
    ;;
  manifest)
    mkdir -p dist/release/published
    gh release download "$GITHUB_REF_NAME" --dir dist/release/published
    inputs=()
    if [ -f dist/release/published/app-update-manifest.json ]; then
      inputs+=(--mac-manifest dist/release/published/app-update-manifest.json)
    fi
    if compgen -G 'dist/release/published/butler-app-*-linux-*.deb' > /dev/null; then
      inputs+=(--linux-dir dist/release/published)
    fi
    if [ -f dist/release/app-windows/app-update-manifest.json ]; then
      inputs+=(--windows-dir dist/release/app-windows)
      shopt -s nullglob
      files=(dist/release/app-windows/*.exe dist/release/app-windows/*.nupkg dist/release/app-windows/*.zip dist/release/app-windows/RELEASES dist/release/app-windows/*.sha256)
      gh release upload "$GITHUB_REF_NAME" "${files[@]}" --clobber
    fi
    if [ "${#inputs[@]}" -eq 0 ]; then exit 0; fi
    python3 deploy/app/merge-update-manifest.py "${inputs[@]}" \
      --version "${GITHUB_REF_NAME#v}" \
      --base-url "https://github.com/$GH_REPO/releases/download/$GITHUB_REF_NAME" \
      --output "$task_data/app-update-manifest.json"
    gh release upload "$GITHUB_REF_NAME" "$task_data/app-update-manifest.json" --clobber
    ;;
  *) printf 'Expected linux or manifest mode\n' >&2; exit 2 ;;
esac
