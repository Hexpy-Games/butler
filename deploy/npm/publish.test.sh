#!/usr/bin/env bash
# test-category: pure-logic
# Registry decisions and release admission, with no network or real publish.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
export HOME="$scratch/home" BUTLER_DATA="$scratch/data"
mkdir -p "$HOME" "$BUTLER_DATA" "$scratch/bin" "$scratch/package"
export PATH="$scratch/bin:$PATH" LOG="$scratch/log"
cat > "$scratch/package/package.json" <<'JSON'
{"name":"@hexpygames/butler","version":"0.1.0"}
JSON
cat > "$scratch/bin/npm" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = view ]; then
  case "$STATE" in
    missing) echo '{"error":{"code":"E404"}}'; exit 1 ;;
    previews) echo '["0.1.0-preview.1","0.1.0-preview.2"]' ;;
    single) echo '"0.1.0-preview.1"' ;;
    stable) echo '["0.1.0","0.2.0-preview.1"]' ;;
    denied) echo '{"error":{"code":"E403"}}'; exit 1 ;;
    network) echo '{"error":{"code":"E503"}}'; exit 1 ;;
    malformed) echo 'not JSON'; exit 1 ;;
    bad-success) echo '{}' ;;
  esac
else
  printf '%s\n' "$*" >> "$LOG"
fi
STUB
chmod +x "$scratch/bin/npm"
cat > "$scratch/bin/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [ "$RELEASE_STATE" = missing ]; then exit 1; fi
jq -n --arg state "$RELEASE_STATE" '
  {tagName: "v0.1.0-preview.3", isDraft: ($state == "draft"),
   publishedAt: (if $state == "unpublished" then null else "2026-10-01" end),
   assets: (["butler-0.1.0-preview.3-SHA256SUMS",
             "butler-agent-0.1.0-darwin-arm64.tar.gz",
             "butler-agent-0.1.0-linux-x64.tar.gz",
             "butler-agent-0.1.0-linux-arm64.tar.gz"]
     | if $state == "no-archive" then .[:-1]
       elif $state == "no-checksums" then .[1:] else . end
     | map({name: .}))}'
STUB
chmod +x "$scratch/bin/gh"

check_publish() {
  export STATE="$1"
  : > "$LOG"
  bash "$root/deploy/npm/publish.sh" "$2" "$scratch/package"
  printf '%s\n' "$3" > "$scratch/expected"
  diff -u "$scratch/expected" "$LOG"
}

preview='version 0.1.0-preview.3 --no-git-tag-version --allow-same-version'
publish='publish --access public --provenance --tag'
next='dist-tag add @hexpygames/butler@0.1.0-preview.3 next'
latest='dist-tag add @hexpygames/butler@0.1.0-preview.3 latest'
check_publish missing v0.1.0-preview.3 "$preview
$publish latest
$next"
for state in previews single; do
  check_publish "$state" v0.1.0-preview.3 "$preview
$publish next
$latest"
done
check_publish stable v0.1.0-preview.3 "$preview
$publish next"
check_publish stable v0.2.0 'version 0.2.0 --no-git-tag-version --allow-same-version
publish --access public --provenance --tag latest'
for state in denied network malformed bad-success; do
  export STATE="$state"
  : > "$LOG"
  if bash "$root/deploy/npm/publish.sh" v0.1.0-preview.3 "$scratch/package"; then
    echo "Unexpected success for $state" >&2; exit 1
  fi
  test ! -s "$LOG"
done
echo 'PASS: 9 npm decision cases'
export RELEASE_STATE=published
bash "$root/deploy/npm/verify-release.sh" v0.1.0-preview.3
for state in missing draft unpublished no-archive no-checksums; do
  export RELEASE_STATE="$state"
  if bash "$root/deploy/npm/verify-release.sh" v0.1.0-preview.3; then
    echo "Unexpected release admission for $state" >&2; exit 1
  fi
done
echo 'PASS: 6 release admission cases'
