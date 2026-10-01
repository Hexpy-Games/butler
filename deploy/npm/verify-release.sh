#!/usr/bin/env bash
set -euo pipefail
tag="${1:?Usage: verify-release.sh vVERSION}"
version="${tag#v}"
archive_version="${version%%-*}"
release="$(gh release view "$tag" --json tagName,isDraft,publishedAt,assets)"
jq -e --arg tag "$tag" --arg version "$version" --arg base "$archive_version" '
  .tagName == $tag and .isDraft == false and .publishedAt != null
  and ([.assets[].name] as $names
    | ["butler-" + $version + "-SHA256SUMS",
       "butler-agent-" + $base + "-darwin-arm64.tar.gz",
       "butler-agent-" + $base + "-linux-x64.tar.gz",
       "butler-agent-" + $base + "-linux-arm64.tar.gz"]
    | all(.[]; . as $asset | $names | index($asset) != null))
' <<< "$release" >/dev/null || {
  echo 'A published GitHub Release with all Agent archives and checksums is required.' >&2
  exit 1
}
