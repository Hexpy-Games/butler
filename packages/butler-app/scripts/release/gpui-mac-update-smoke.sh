#!/usr/bin/env bash
# Destructive install/update proof, only for disposable hosted runners.
set -euo pipefail

if [ "${GITHUB_ACTIONS:-}" != true ] || [ "${RUNNER_ENVIRONMENT:-}" != github-hosted ]; then
  echo 'gpui update smoke requires a disposable GitHub-hosted runner' >&2
  exit 1
fi
[ "$#" -eq 2 ] || { echo 'usage: gpui-mac-update-smoke.sh <electron.dmg> <gpui.dmg>' >&2; exit 1; }
electron=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
gpui=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")
repo=$(cd "$(dirname "$0")/../../../.." && pwd)
root=$(mktemp -d "$RUNNER_TEMP/gpui-update.XXXXXX")
export HOME="$root/home" BUTLER_DATA="$root/data" TMPDIR="$root/tmp"
export BUTLER_E2E_TIER=stub BUTLER_SECRET_STORE=file BUTLER_APP_SERVER_HOST=127.0.0.1
export BUTLER_APP_ELECTRON_USER_DATA_DIR="$root/electron" BUTLER_APP_UPDATE_MANIFEST="$root/manifest.json"
export BUTLER_APP_DISABLE_SHELL_REGISTRATION=1
install="$root/install/Butler.app"
exe="$install/Contents/MacOS/Butler"
agent_exe="$install/Contents/Resources/bundled-agent/bin/butler-agent"
manifest_rel=Contents/Resources/bundled-agent/native-agent-manifest.json
record="$BUTLER_DATA/state/butler-agent-native-service.json"
app_log="$root/app.log"
app_pid=
helper_pid=
host_pid=
old_agent_pid=
baseline_agent_pid=
mounted=false
gpui_wait=
phase=
started=0

fail() { echo "gpui update smoke FAILED: $*" >&2; exit 1; }
now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }

finish_step() {
  printf '{"step":"%s","durationMs":%s}\n' "$phase" "$(($(now_ms) - started))"
  phase=
}

step() {
  phase=$1
  shift
  started=$(now_ms)
  "$@"
  finish_step
}

alive() {
  [ -n "$1" ] && kill -0 "$1" 2>/dev/null && [ "$(ps -o stat= -p "$1" 2>/dev/null | cut -c1)" != Z ]
}

stop_pids() {
  local pid deadline pending
  for pid in "$@"; do
    [ -z "$pid" ] || /bin/kill -TERM "$pid" 2>/dev/null || true
  done
  deadline=$((SECONDS + 30))
  while :; do
    pending=false
    for pid in "$@"; do alive "$pid" && pending=true; done
    [ "$pending" = true ] || return 0
    [ "$SECONDS" -lt "$deadline" ] || return 1
    sleep 1
  done
}

cleanup() {
  result=$?
  trap - EXIT HUP INT TERM PIPE
  if [ "$result" -ne 0 ]; then
    [ -z "$phase" ] || finish_step
    for file in "$app_log" "$root/helper.out" "$root/helper.log" "$root/host.log" "$record"; do
      [ ! -f "$file" ] || { echo "--- $file" >&2; cat "$file" >&2; }
    done
  fi
  agent_pid=
  if [ "$result" -ne 0 ] && [ -f "$record" ]; then
    agent_pid=$(jq -r '.pid // empty' "$record" 2>/dev/null || true)
    [ -z "$agent_pid" ] || [ "$(ps -o comm= -p "$agent_pid" 2>/dev/null)" = "$agent_exe" ] || agent_pid=
  fi
  if ! stop_pids "$app_pid" "$helper_pid" "$host_pid" "$agent_pid" "$old_agent_pid"; then
    for pid in "$app_pid" "$helper_pid" "$host_pid" "$agent_pid" "$old_agent_pid"; do
      [ -z "$pid" ] || /bin/kill -KILL "$pid" 2>/dev/null || true
    done
  fi
  if [ "$mounted" = true ]; then hdiutil detach "$root/mount" >&2 || result=1; fi
  chmod -R u+w "$root" 2>/dev/null || true
  rm -rf "$root" || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM PIPE

mkdir -p "$HOME" "$BUTLER_DATA" "$TMPDIR" "$BUTLER_APP_ELECTRON_USER_DATA_DIR" "$root/install" "$root/mount"
BUTLER_APP_SERVER_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
export BUTLER_APP_SERVER_PORT

install_electron() {
  local deadline
  hdiutil attach -readonly -nobrowse -mountpoint "$root/mount" "$electron" >&2
  mounted=true
  ditto "$root/mount/Butler.app" "$install"
  hdiutil detach "$root/mount" >&2
  mounted=false
  from=$(jq -er .appVersion "$install/$manifest_rel")
  printf '{"app_version":"%s","artifacts":[]}\n' "$from" > "$BUTLER_APP_UPDATE_MANIFEST"
  team=$(codesign -dv --verbose=4 "$gpui" 2>&1 | sed -n 's/^TeamIdentifier=//p' | grep -vx 'not set' || true)
  if [ -z "$team" ]; then
    BUTLER_SIGN_IDENTITY=- BUTLER_SIGN_KEYCHAIN= BUTLER_SIGN_TEAM_ID= \
      "$repo/deploy/macos/sign-and-notarize.sh" sign-app "$install" >&2
    echo 'baseline re-signed ad-hoc: the candidate is an ad-hoc build and the updater requires one signing team'
  fi
  "$exe" >> "$app_log" 2>&1 &
  app_pid=$!
  deadline=$((SECONDS + 120))
  until jq -e '.state == "ready" and (.pid > 0)' "$record" >/dev/null 2>&1 && alive "$(jq -r .pid "$record")"; do
    alive "$app_pid" || fail 'App exited during startup'
    [ "$SECONDS" -lt "$deadline" ] || fail 'Agent readiness exceeded 120 seconds'
    sleep 1
  done
  old_agent_pid=$(jq -r .pid "$record")
  baseline_agent_pid=$old_agent_pid
  printf retained > "$BUTLER_DATA/sentinel.txt"
}

update() {
  local deadline
  mkfifo "$root/helper.fifo"
  "$agent_exe" --installation-root "$install" \
    --resource-root "$install/Contents/Resources/bundled-agent/resources" \
    app-update-install "$gpui" "$exe" "$app_pid" --use-mock-keychain \
    < "$root/helper.fifo" > "$root/helper.out" 2> "$root/helper.log" &
  helper_pid=$!
  exec 3> "$root/helper.fifo"
  deadline=$((SECONDS + 120))
  until grep -qsx app-update-ready "$root/helper.out"; do
    alive "$helper_pid" || fail 'update helper exited before readiness'
    [ "$SECONDS" -lt "$deadline" ] || fail 'update helper readiness exceeded 120 seconds'
    sleep 1
  done
  echo activate >&3
  exec 3>&-
  stop_pids "$app_pid" "$old_agent_pid" || fail 'baseline App or Agent did not exit'
  wait "$app_pid" 2>/dev/null || true
  app_pid=
  old_agent_pid=
  deadline=$((SECONDS + 90))
  while alive "$helper_pid"; do
    [ "$SECONDS" -lt "$deadline" ] || fail 'update helper still running after 90 seconds'
    sleep 1
  done
  if ! wait "$helper_pid"; then
    helper_pid=
    app_pid=$(app_process || true)
    fail 'update helper failed'
  fi
  helper_pid=
}

# Pid of a process started from the installed App path (macOS ps comm is argv[0]).
app_process() {
  ps -axo pid=,comm= | awk -v exe="$exe" '{ pid = $1; $1 = ""; sub(/^ /, ""); if ($0 == exe) { print pid; exit } }'
}

gpui_ready() {
  # Record the relaunched App first so cleanup can stop it even if a later check times out.
  app_pid=$(app_process)
  jq -e '.state == "ready" and (.pid > 0)' "$record" >/dev/null 2>&1 || { gpui_wait=record; return 1; }
  new_agent=$(jq -r .pid "$record")
  { alive "$new_agent" && [ "$new_agent" != "$baseline_agent_pid" ]; } || { gpui_wait=new_agent_process; return 1; }
  jq -e '.app_supervised == true' "$record" >/dev/null || { gpui_wait=app_supervised; return 1; }
  comm=$(ps -o comm= -p "$new_agent" 2>/dev/null || true)
  [ "$comm" = "$agent_exe" ] || { gpui_wait="agent_exe $comm"; return 1; }
  # Identifies the process started from the installed path (macOS ps comm is argv[0]).
  { [ -n "$app_pid" ] && alive "$app_pid"; } || { gpui_wait=app_process_from_installed_path; return 1; }
  token=$(jq -er .token "$BUTLER_DATA/app/runtime/auth/local-agent-auth.json" 2>/dev/null) || { gpui_wait=token; return 1; }
  endpoint=$(jq -er .app_endpoint "$record") || { gpui_wait=endpoint; return 1; }
  health_exit=0
  curl -fsS --max-time 5 -H "Authorization: Bearer $token" -o "$root/health.json" "$endpoint/health" || health_exit=$?
  if [ "$health_exit" -ne 0 ] || ! jq -e '.data.ok == true' "$root/health.json" >/dev/null; then
    gpui_wait="health curl=$health_exit"; return 1
  fi
}

prove_gpui() {
  local deadline path
  deadline=$((SECONDS + 120))
  until gpui_ready; do
    [ "$SECONDS" -lt "$deadline" ] || fail "gpui readiness exceeded 120 seconds (pending: $gpui_wait)"
    sleep 1
  done
  for path in Contents/MacOS/butler-cef-host \
    "Contents/Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework"; do
    [ -f "$install/$path" ] || fail "missing $path"
  done
  [ ! -e "$install/Contents/Frameworks/Electron Framework.framework" ] || fail 'Electron Framework remains'
  [ ! -e "$install/Contents/Resources/app.asar" ] || fail 'Electron app.asar remains'
  codesign --verify --deep --strict "$install" || fail 'installed bundle signature invalid'
  [ "$(cat "$BUTLER_DATA/sentinel.txt")" = retained ] || fail 'user data lost'
  to=$(jq -er .appVersion "$install/$manifest_rel")
  [ "$to" != "$from" ] || fail "version unchanged: $from"
  stop_pids "$app_pid" "$new_agent" || fail 'App or Agent did not exit'
  wait "$app_pid" 2>/dev/null || true
  app_pid=
  new_agent=
}

prove_host() {
  local deadline
  mkfifo "$root/host.in"
  exec 5<> "$root/host.in"
  # The Agent's headless host: DevTools pipe on fds 3 (in) and 4 (out); the open silent pipe keeps it up.
  "$install/Contents/MacOS/butler-cef-host" --remote-debugging-pipe --user-data-dir="$root/host-profile" \
    --no-first-run --no-default-browser-check --disable-background-networking --disable-component-update \
    --disable-sync --disable-breakpad --disable-crash-reporter --disable-domain-reliability \
    --disable-features=Translate,MediaRouter,OptimizationHints,DialMediaRouteProvider \
    --password-store=basic --use-mock-keychain --mute-audio --window-size=1280,800 about:blank \
    3< "$root/host.in" 4> "$root/host.out" >> "$root/host.log" 2>&1 &
  host_pid=$!
  deadline=$((SECONDS + 30))
  until [[ "$(lsappinfo find pid="$host_pid")" == ASN:* ]]; do
    alive "$host_pid" || fail 'CEF host exited'
    [ "$SECONDS" -lt "$deadline" ] || fail 'CEF host did not register with LaunchServices within 30 seconds'
    sleep 1
  done
  [ -z "$(app_process)" ] || fail 'an App process from the previous step is still running'
  # Without -n, LaunchServices activates a running instance of the bundle instead of starting one.
  open --env BUTLER_DATA="$BUTLER_DATA" --env HOME="$HOME" --env TMPDIR="$TMPDIR" \
    --env BUTLER_E2E_TIER=stub --env BUTLER_SECRET_STORE=file --env BUTLER_APP_SERVER_HOST=127.0.0.1 \
    --env BUTLER_APP_SERVER_PORT="$BUTLER_APP_SERVER_PORT" --env BUTLER_APP_UPDATE_MANIFEST="$BUTLER_APP_UPDATE_MANIFEST" \
    --env BUTLER_APP_DISABLE_SHELL_REGISTRATION=1 "$install" --args --use-mock-keychain
  deadline=$((SECONDS + 60))
  until gpui_ready; do
    [ "$SECONDS" -lt "$deadline" ] || fail "opening the App did not start it while its CEF host was running (pending: $gpui_wait)"
    sleep 1
  done
  alive "$host_pid" || fail 'CEF host exited before the App started'
  stop_pids "$app_pid" "$host_pid" "$new_agent" || fail 'App, CEF host or Agent did not exit'
  app_pid=
  host_pid=
  new_agent=
  exec 5>&-
}

step electron install_electron
step update update
step gpui prove_gpui
step host prove_host
printf '{"ok":true,"from":"%s","to":"%s"}\n' "$from" "$to"
