#!/bin/sh
# Installs a Butler Linux App package in a clean container and runs its bundled
# native agent headless: version, service start with a temporary BUTLER_DATA,
# authenticated GET /health, CLI stop, and an unchanged installation.
#
# Run as root inside a fresh distribution container, for example:
#   docker run --rm -v "$PWD/dist:/pkg:ro" -v "$PWD/packages/butler-app/scripts/release:/smoke:ro" \
#     ubuntu:24.04 sh /smoke/linux-package-smoke.sh /pkg/butler-app-0.0.21-linux-x64.deb
# The package format follows the file name (.deb or .pkg.tar.zst).
set -eu

package="${1:?usage: linux-package-smoke.sh <package file>}"
port="${BUTLER_SMOKE_PORT:-18799}"

fail() {
  echo "linux package smoke FAILED: $*" >&2
  exit 1
}

install_package() {
  case "$package" in
    *.deb)
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq
      apt-get install -y -qq --no-install-recommends "$package" curl ca-certificates >/dev/null
      ;;
    *.pkg.tar.zst)
      pacman -Syu --noconfirm --needed curl >/dev/null
      pacman -U --noconfirm "$package" >/dev/null
      ;;
    *) fail "unknown package format: $package" ;;
  esac
}

install_package
install_dir="$(find /opt/butler -mindepth 1 -maxdepth 1 -type d -name 'Butler-linux-*' | head -n 1)"
[ -n "$install_dir" ] || fail "no /opt/butler/Butler-linux-* installation"
agent="$install_dir/resources/bundled-agent/bin/butler-agent"
resources="$install_dir/resources/bundled-agent/resources"
for path in "$install_dir/Butler" "$agent" /usr/bin/butler-app; do
  [ -x "$path" ] || fail "missing executable $path"
done
[ -f /usr/share/applications/butler.desktop ] || fail "missing desktop entry"
[ -f "$resources/app-client/dist/index.html" ] || fail "missing bundled App client"
[ "$(stat -c '%a %U' "$install_dir/chrome-sandbox")" = "4755 root" ] || fail "chrome-sandbox is not setuid root"
missing="$(ldd "$install_dir/Butler" "$agent" | grep 'not found' || true)"
[ -z "$missing" ] || fail "unresolved shared libraries: $missing"
before="$(find "$install_dir" -type f -exec sha256sum {} + | sort | sha256sum)"

# The agent runs as an ordinary user, as the App would start it.
id butler-smoke >/dev/null 2>&1 || useradd -m butler-smoke
work="$(runuser -u butler-smoke -- mktemp -d)"
cat > "$work/run.sh" <<EOF
set -eu
cd "$work"
mkdir -p home data tmp
export HOME="$work/home" TMPDIR="$work/tmp" BUTLER_DATA="$work/data" LANG=C.UTF-8 TZ=UTC
export BUTLER_APP_SERVER_HOST=127.0.0.1 BUTLER_APP_SERVER_PORT=$port BUTLER_METRICS_ENABLED=0
# Resolve the agent the way the App does: the packaged resolver module run by
# the installed Electron binary in plain Node mode (no display needed).
cat > resolve.mjs <<'JS'
import { pathToFileURL } from "node:url";
const [appDir, resourcesPath, execPath] = process.argv.slice(2);
const { resolveBundledNativeAgentInstallation } = await import(pathToFileURL(appDir + "/bundled-native-agent.mjs").href);
const installation = resolveBundledNativeAgentInstallation({ butlerData: "/tmp/butler-smoke-data", resourcesPath, execPath, platform: "linux" });
console.log(JSON.stringify(installation));
JS
ELECTRON_RUN_AS_NODE=1 "$install_dir/Butler" resolve.mjs "$install_dir/resources/app" "$install_dir/resources" "$install_dir/Butler" > resolved.json || { cat resolved.json; exit 10; }
grep -q '"command":"'"$agent"'"' resolved.json || { cat resolved.json; exit 10; }
grep -q '"'"$install_dir"'"' resolved.json || { cat resolved.json; exit 10; }
agent() { "$agent" --installation-root "$install_dir" --resource-root "$resources" "\$@"; }
agent version --json > version.json
grep -q '"ok": *true' version.json || { cat version.json; exit 11; }
agent > agent.log 2>&1 < /dev/null &
pid=\$!
echo "\$pid" > agent.pid
token=""
i=0
while [ \$i -lt 90 ]; do
  kill -0 "\$pid" 2>/dev/null || { tail -n 60 agent.log; exit 12; }
  token="\$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' data/app/runtime/auth/local-agent-auth.json 2>/dev/null || true)"
  if [ -n "\$token" ] && curl -fsS -H "Authorization: Bearer \$token" "http://127.0.0.1:$port/health" > health.json 2>/dev/null; then
    break
  fi
  i=\$((i + 1))
  sleep 1
done
grep -q '"ok": *true' health.json 2>/dev/null || { tail -n 60 agent.log; exit 13; }
echo "health: \$(cat health.json)"
agent stop --json > stop.json 2>&1 || { cat stop.json; tail -n 60 agent.log; exit 14; }
# An exited child stays a zombie until waited for, so check its state.
running() { [ -r "/proc/\$pid/status" ] && ! grep -q '^State:[[:space:]]*Z' "/proc/\$pid/status"; }
i=0
while running; do
  i=\$((i + 1))
  [ \$i -lt 30 ] || { kill -TERM "\$pid"; tail -n 60 agent.log; exit 15; }
  sleep 1
done
wait "\$pid" || { echo "agent exit status \$?"; tail -n 60 agent.log; exit 16; }
EOF
chown butler-smoke "$work/run.sh"
runuser -u butler-smoke -- sh "$work/run.sh" || fail "headless agent run (exit $?)"
after="$(find "$install_dir" -type f -exec sha256sum {} + | sort | sha256sum)"
[ "$before" = "$after" ] || fail "the agent changed its installation"
echo "linux package smoke passed: $(basename "$package")"
