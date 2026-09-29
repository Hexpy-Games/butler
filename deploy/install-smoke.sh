#!/bin/sh
# End-to-end check of the CLI install path, offline: serves a locally built
# agent archive over http, installs it with deploy/install.sh into a temporary
# HOME, runs the agent headless, and re-installs.
#
#   deploy/install-smoke.sh <dist dir> [<packed npm tarball>]
#
# <dist dir> holds butler-agent-<version>-<platform>.tar.gz (package-standalone-agent.py).
# With a tarball (npm pack), also installs into a second fresh HOME through
# `npx <tarball> install`. Touches nothing outside its temporary directory.
set -eu

dist="${1:?usage: install-smoke.sh <dist dir> [<npm tarball>]}"
tarball="${2:-}"
here="$(cd "$(dirname "$0")" && pwd)"
port="${BUTLER_SMOKE_PORT:-18797}"
agent_port="${BUTLER_SMOKE_AGENT_PORT:-18798}"

fail() { echo "install smoke FAILED: $*" >&2; exit 1; }

set -- "$dist"/butler-agent-*.tar.gz
[ -f "$1" ] || fail "no butler-agent-*.tar.gz in $dist"
name="$(basename "$1")"
version="$(printf '%s' "$name" | sed 's/^butler-agent-\([^-]*\)-.*/\1/')"

work="$(mktemp -d)"
server=""
cleanup() {
  [ -z "$server" ] || kill "$server" 2>/dev/null || true
  # A failed run must not leave an agent behind.
  BUTLER_DATA="$work/data" "$work/home/.local/bin/butler" stop >/dev/null 2>&1 || true
  chmod -R u+w "$work" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 1' INT TERM HUP

# Serve the archive and the checksum file the way a release does.
mkdir "$work/serve" "$work/home" "$work/data"
ln -s "$(cd "$dist" && pwd)/$name" "$work/serve/$name"
(cd "$work/serve" && if command -v sha256sum >/dev/null 2>&1; then sha256sum "$name"; else shasum -a 256 "$name"; fi) \
  > "$work/serve/butler-$version-SHA256SUMS"
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$work/serve" >/dev/null 2>&1 &
server=$!

export HOME="$work/home" BUTLER_DATA="$work/data" BUTLER_AGENT_HOME="$work/agent"
export BUTLER_VERSION="$version" BUTLER_INSTALL_BASE_URL="http://127.0.0.1:$port"
export BUTLER_APP_SERVER_HOST=127.0.0.1 BUTLER_APP_SERVER_PORT="$agent_port"
export BUTLER_SECRET_STORE=file BUTLER_METRICS_ENABLED=0
export PATH="$HOME/.local/bin:$PATH"

i=0
until curl -fs "$BUTLER_INSTALL_BASE_URL/butler-$version-SHA256SUMS" >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -lt 30 ] || fail "local release server did not start"; sleep 0.2
done

echo "== install (fresh, starts Butler)"
sh "$here/install.sh" || fail "install.sh"
command -v butler >/dev/null || fail "butler is not on PATH after install"
[ -L "$BUTLER_AGENT_HOME/current" ] || fail "current is not a symlink"
[ "$(sed -n 2p "$HOME/.local/bin/butler")" = "# butler-native-launcher v1" ] || fail "launcher marker"

butler version --json > "$work/version.json" || fail "butler version"
grep -q '"ok": *true' "$work/version.json" || { cat "$work/version.json"; fail "butler version is not ok"; }
grep -q "\"version\": *\"$version\"" "$work/version.json" || { cat "$work/version.json"; fail "wrong version"; }
grep -q '"availability": *"installed_manifest"' "$work/version.json" || { cat "$work/version.json"; fail "version provenance missing"; }

token_file="$BUTLER_DATA/app/runtime/auth/local-agent-auth.json"
token="$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$token_file" 2>/dev/null | head -n 1)"
[ -n "$token" ] || fail "no agent token in the data folder"
curl -fsS -H "Authorization: Bearer $token" "http://127.0.0.1:$agent_port/health" | grep -q '"ok": *true' || fail "authenticated /health"
butler stop || fail "butler stop"

echo "== install (again, must change nothing)"
state() { { ls -A "$BUTLER_AGENT_HOME"; readlink "$BUTLER_AGENT_HOME/current"; cat "$HOME/.local/bin/butler"; find "$BUTLER_DATA" | sort; } | sort; }
before="$(state)"
sh "$here/install.sh" --no-start || fail "second install.sh"
[ "$before" = "$(state)" ] || fail "a second install changed the installation or data"

echo "== install over another active version (switches current, keeps previous)"
active="$(readlink "$BUTLER_AGENT_HOME/current")"
mkdir "$BUTLER_AGENT_HOME/0.0.0-00000000"
ln -sfn 0.0.0-00000000 "$BUTLER_AGENT_HOME/current"
sh "$here/install.sh" --no-start || fail "install.sh over another version"
[ "$(readlink "$BUTLER_AGENT_HOME/current")" = "$active" ] || fail "current was not switched back"
[ "$(readlink "$BUTLER_AGENT_HOME/previous")" = "0.0.0-00000000" ] || fail "previous was not recorded"
[ -d "$BUTLER_AGENT_HOME/0.0.0-00000000" ] || fail "an install removed an old version"

if [ -n "$tarball" ]; then
  echo "== npx install (fresh home)"
  export HOME="$work/home-npx" BUTLER_AGENT_HOME="$work/agent-npx" BUTLER_DATA="$work/data-npx"
  mkdir "$HOME"
  export PATH="$HOME/.local/bin:$PATH"
  # BUTLER_VERSION and BUTLER_INSTALL_BASE_URL (exported above) point the wrapper at the local archive.
  npx --yes --package="$tarball" butler-install install --no-start || fail "npx install"
  butler version --json | grep -q "\"version\": *\"$version\"" || fail "npx-installed version"
  npx --yes --package="$tarball" butler-install version --json | grep -q "\"version\": *\"$version\"" || fail "npx forwarding to butler"
fi
echo "install smoke passed: $name"
