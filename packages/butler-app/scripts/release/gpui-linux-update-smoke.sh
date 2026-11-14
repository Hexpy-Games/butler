#!/bin/sh
# Destructive install/upgrade/purge proof, only for disposable hosted runners.
set -eu

if [ "${GITHUB_ACTIONS:-}" != true ] || [ "${RUNNER_ENVIRONMENT:-}" != github-hosted ]; then
  echo 'gpui upgrade smoke requires a disposable GitHub-hosted runner' >&2
  exit 1
fi
[ "$#" -eq 2 ] || { echo 'usage: gpui-linux-update-smoke.sh <electron.deb> <gpui.deb>' >&2; exit 1; }
electron=$(realpath "$1")
gpui=$(realpath "$2")
from=$(dpkg-deb -f "$electron" Version | sed 's/~/-/')
to=$(dpkg-deb -f "$gpui" Version | sed 's/~/-/')
root=$(mktemp -d)
export HOME="$root/home" BUTLER_DATA="$root/data" TMPDIR="$root/tmp"
export XDG_CONFIG_HOME="$root/config" XDG_CACHE_HOME="$root/cache" XDG_DATA_HOME="$root/share"
export XDG_STATE_HOME="$root/state" XDG_RUNTIME_DIR="$root/runtime"
export BUTLER_E2E_TIER=stub BUTLER_SECRET_STORE=file BUTLER_APP_SERVER_HOST=127.0.0.1
export BUTLER_APP_ELECTRON_USER_DATA_DIR="$root/electron" BUTLER_APP_UPDATE_MANIFEST="$root/manifest.json"
export DEBIAN_FRONTEND=noninteractive
install_dir=/opt/butler/Butler-linux-x64
record="$BUTLER_DATA/state/butler-agent-native-service.json"
app_log="$root/app.log"
launcher_pid=
agent_pid=
phase=
purged=false
started=0

fail() { echo "gpui upgrade smoke FAILED: $*" >&2; exit 1; }

finish_step() {
  printf '{"step":"%s","durationMs":%s}\n' "$phase" "$(($(date +%s%3N) - started))"
  phase=
}

step() {
  phase=$1
  shift
  started=$(date +%s%3N)
  "$@"
  finish_step
}

alive() {
  [ -n "$1" ] && [ -r "/proc/$1/stat" ] && [ "$(ps -o stat= -p "$1" | cut -c1)" != Z ]
}

capture_agent() {
  # Capture the Agent even when startup failed before the ready check.
  if [ -z "$agent_pid" ] && [ -f "$record" ]; then
    agent_pid=$(jq -r '.pid // empty' "$record" 2>/dev/null || true)
  fi
}

stop_app() {
  capture_agent
  if [ -n "$launcher_pid" ]; then
    /bin/kill -TERM -- "-$launcher_pid" 2>/dev/null || true
    deadline=$(($(date +%s) + 30))
    while alive "$launcher_pid" || alive "$agent_pid"; do
      [ "$(date +%s)" -lt "$deadline" ] || fail 'App or Agent did not exit'
      sleep 1
    done
    wait "$launcher_pid" 2>/dev/null || true
  fi
  launcher_pid=
  agent_pid=
}

cleanup() {
  result=$?
  trap - 0 HUP INT TERM
  if [ "$result" -ne 0 ]; then
    [ -z "$phase" ] || finish_step
    [ ! -f "$app_log" ] || cat "$app_log" >&2
    [ ! -f "$record" ] || cat "$record" >&2
  fi
  # A cleanup failure must not prevent purge or removal of the isolated profile.
  capture_agent
  (stop_app) || {
    result=1
    [ -z "$launcher_pid" ] || /bin/kill -KILL -- "-$launcher_pid" 2>/dev/null || true
    [ -z "$agent_pid" ] || /bin/kill -KILL -- "-$agent_pid" 2>/dev/null || true
    [ -z "$launcher_pid" ] || wait "$launcher_pid" 2>/dev/null || true
  }
  if [ "$purged" != true ]; then
    sudo apt-get purge -y butler-app >&2 || result=1
  fi
  rm -rf "$root"
  exit "$result"
}
trap cleanup 0
trap 'exit 1' HUP INT TERM

mkdir -p "$HOME" "$BUTLER_DATA" "$TMPDIR" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" \
  "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_RUNTIME_DIR" "$BUTLER_APP_ELECTRON_USER_DATA_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
BUTLER_APP_SERVER_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
export BUTLER_APP_SERVER_PORT
printf '{"app_version":"%s","artifacts":[]}\n' "$from" > "$BUTLER_APP_UPDATE_MANIFEST"

start_app() {
  # The non-job-control shell's child is not a group leader: setsid keeps $!.
  setsid xvfb-run -a /usr/bin/butler-app >> "$app_log" 2>&1 &
  launcher_pid=$!
  deadline=$(($(date +%s) + 120))
  while :; do
    alive "$launcher_pid" || fail 'App exited during startup'
    remaining=$((deadline - $(date +%s)))
    [ "$remaining" -gt 0 ] || fail 'Agent readiness exceeded 120 seconds'
    if jq -e '.state == "ready" and (.pid > 0)' "$record" >/dev/null 2>&1; then
      agent_pid=$(jq -r '.pid' "$record")
      if alive "$agent_pid"; then
        if [ "${1:-electron}" = electron ] || gpui_ready; then break; fi
      fi
    fi
    sleep 1
  done
}

install_electron() {
  sudo apt-get install -y "$electron" >&2
  had_asar=false
  [ ! -e "$install_dir/resources/app.asar" ] || had_asar=true
  start_app
  printf retained > "$BUTLER_DATA/sentinel.txt"
  stop_app
}

upgrade() {
  sudo dpkg -i "$gpui" >&2
  for name in libcef.so butler-cef-host; do
    [ -f "$install_dir/$name" ] || fail "missing $name"
  done
  if [ "$had_asar" = true ]; then
    [ ! -e "$install_dir/resources/app.asar" ] || fail 'Electron app.asar remains'
  fi
  [ ! -e "$install_dir/libffmpeg.so" ] || fail 'Electron libffmpeg.so remains'
}

gpui_ready() {
  jq -e '.app_supervised == true' "$record" >/dev/null || return 1
  [ "$(readlink "/proc/$agent_pid/exe")" = "$install_dir/resources/bundled-agent/bin/butler-agent" ] || return 1
  # gpui has no Electron foreground record: identify the App in our session.
  app_pid=$(ps -eo pid=,sid= | awk -v sid="$launcher_pid" '$2 == sid { print $1 }' | while read -r pid; do
    if [ "$(readlink "/proc/$pid/exe" 2>/dev/null || true)" = "$install_dir/Butler" ]; then printf '%s\n' "$pid"; fi
  done)
  [ -n "$app_pid" ] && alive "$app_pid" || return 1
  token=$(jq -er '.token' "$BUTLER_DATA/app/runtime/auth/local-agent-auth.json" 2>/dev/null) || return 1
  endpoint=$(jq -er '.app_endpoint' "$record") || return 1
  remaining=$((deadline - $(date +%s)))
  [ "$remaining" -gt 0 ] || return 1
  [ "$remaining" -le 5 ] || remaining=5
  curl -fsS --max-time "$remaining" -H "Authorization: Bearer $token" "$endpoint/health" | jq -e '.ok == true' >/dev/null || return 1
}

prove_gpui() {
  start_app gpui
  [ "$(cat "$BUTLER_DATA/sentinel.txt")" = retained ] || fail 'user data lost'
  [ -f "$BUTLER_DATA/butler.config.json" ] || fail 'user configuration missing'
  stop_app
}

purge() {
  sudo apt-get purge -y butler-app >&2
  purged=true
  for path in /opt/butler /usr/bin/butler-app /usr/bin/butler /usr/share/applications/butler.desktop \
    /usr/share/icons/hicolor/512x512/apps/butler.png; do
    [ ! -e "$path" ] && [ ! -L "$path" ] || fail "purge left $path"
  done
  if dpkg -S /opt/butler >/dev/null 2>&1; then fail 'package still owns /opt/butler'; fi
  [ "$(cat "$BUTLER_DATA/sentinel.txt")" = retained ] || fail 'purge removed user data'
}

step electron install_electron
step upgrade upgrade
step gpui prove_gpui
step purge purge
printf '{"ok":true,"from":"%s","to":"%s"}\n' "$from" "$to"
