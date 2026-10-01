#!/usr/bin/env bash
set -euo pipefail
tag="${1:?Usage: publish.sh vVERSION [package-directory]}"
version="${tag#v}"
if [[ "$tag" != v* ]] || ! jq -en --arg v "$version" \
  '$v | test("^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?$")' >/dev/null; then
  echo 'Expected a version tag such as v0.1.0-preview.3' >&2
  exit 1
fi
cd "${2:-packages/butler-npm}"
name="$(jq -er '.name' package.json)"
dist_tag=latest
extra_tag=
if [[ "$version" == *-* ]]; then
  # npm's structured E404 is the only failure that permits a first publish.
  # Auth/network failures and malformed responses must fail closed.
  if registry="$(npm view "$name" versions --json)"; then
    has_stable="$(jq -er '
      if type == "string" then [.] else . end
      | if type != "array" or length == 0 or any(.[]; type != "string")
        then error("Invalid registry versions") else . end
      | any(.[]; test("^[0-9]+\\.[0-9]+\\.[0-9]+$")) | tostring
    ' <<< "$registry")"
    dist_tag=next
    if [ "$has_stable" = false ]; then extra_tag=latest; fi
  elif jq -e '.error.code == "E404"' <<< "$registry" >/dev/null; then
    extra_tag=next
  else
    echo 'Could not determine npm registry state; refusing to publish.' >&2
    exit 1
  fi
fi
npm version "$version" --no-git-tag-version --allow-same-version
npm publish --access public --provenance --tag "$dist_tag"
if [ -n "$extra_tag" ]; then
  npm dist-tag add "$name@$version" "$extra_tag"
fi
