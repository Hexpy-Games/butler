#!/usr/bin/env bash
# test-category: pure-logic
# Release admission, with no network.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/butler-verify-release-test.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
export HOME="$scratch/home" BUTLER_DATA="$scratch/data"
mkdir -p "$HOME" "$BUTLER_DATA" "$scratch/bin"
export PATH="$scratch/bin:$PATH"
cat > "$scratch/bin/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [ "$RELEASE_STATE" = missing ]; then exit 1; fi
jq -n --arg state "$RELEASE_STATE" '
  {tagName: "v0.1.0-preview.3", isDraft: ($state == "draft"),
   publishedAt: (if $state == "unpublished" then null else "2026-10-01" end),
   assets: (["butler-0.1.0-preview.3-SHA256SUMS",
             "butler-agent-0.1.0-preview.3-darwin-arm64.tar.gz",
             "butler-agent-0.1.0-preview.3-linux-x64.tar.gz",
             "butler-agent-0.1.0-preview.3-linux-arm64.tar.gz"]
     | if $state == "no-archive" then .[:-1]
       elif $state == "no-checksums" then .[1:] else . end
     | map({name: .}))}'
STUB
chmod +x "$scratch/bin/gh"

export RELEASE_STATE=published
bash "$root/deploy/verify-release.sh" v0.1.0-preview.3
for state in missing draft unpublished no-archive no-checksums; do
  export RELEASE_STATE="$state"
  if bash "$root/deploy/verify-release.sh" v0.1.0-preview.3; then
    echo "Unexpected release admission for $state" >&2; exit 1
  fi
done
echo 'PASS: 6 release admission cases'
