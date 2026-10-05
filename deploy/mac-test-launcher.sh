#!/bin/bash
# A directly launched test bundle owns its foreground Agent and private profile.
set -euo pipefail
package_root=$(cd "$(dirname "$0")" && pwd)
test_home=$(mktemp -d "${TMPDIR:-/tmp}/butler-mac-test.XXXXXX")
log_root=$(dirname "$package_root")/logs/$(date -u +%Y%m%dT%H%M%SZ)
app_pid=
cleanup() {
  result=$?
  trap - EXIT
  if [ -n "$app_pid" ] && kill -0 "$app_pid" 2>/dev/null; then
    kill -TERM "$app_pid"
    wait "$app_pid" || true
  fi
  mkdir -p "$log_root"
  cp "$test_home"/*.log "$log_root/" 2>/dev/null || true
  for relative in logs metrics app/runtime/logs app/runtime/foreground agent-runtime/logs; do
    if [ -d "$BUTLER_DATA/$relative" ]; then
      mkdir -p "$log_root/$relative"
      cp -R "$BUTLER_DATA/$relative/." "$log_root/$relative/"
    fi
  done
  if [ "${smoke_mode:-}" = --smoke ]; then
    python3 - "$BUTLER_DATA" "$BUTLER_APP_SERVER_PORT" <<'PY' || result=1
import json, pathlib, socket, sys
data, port = pathlib.Path(sys.argv[1]), int(sys.argv[2])
record = json.loads((data/'app/runtime/foreground/last-exit.json').read_text())
assert all(record[key] is True for key in ['graceful', 'process_tree_dead', 'port_released']), record
with socket.socket() as s:
    s.bind(('127.0.0.1', port))
print('Clean shutdown: graceful=true; process_tree_dead=true; port_released=true')
PY
  fi
  rm -rf "$test_home"
  printf 'Test app stopped; profile removed; logs: %s\n' "$log_root"
  exit "$result"
}
export HOME="$test_home/home" BUTLER_DATA="$test_home/data"
export CODEX_HOME="$test_home/codex"
export BUTLER_APP_ELECTRON_USER_DATA_DIR="$test_home/electron"
export BUTLER_APP_DISABLE_SHELL_REGISTRATION=1 BUTLER_SERVICE_MANAGER=off
export BUTLER_SECRET_STORE=file BUTLER_PLATFORM_SYSTEM_SECRETS=0
export BUTLER_APP_AGENT_LIFECYCLE_MODE=app-foreground BUTLER_APP_ALLOW_LIFECYCLE_TEST_OVERRIDE=1
export BUTLER_APP_SERVER_HOST=127.0.0.1
export BUTLER_APP_TEST_AUTO_CONNECT=1
export BUTLER_APP_SERVER_PORT
BUTLER_APP_SERVER_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
mkdir -p "$HOME" "$BUTLER_DATA" "$CODEX_HOME" "$BUTLER_APP_ELECTRON_USER_DATA_DIR"
trap 'cleanup' EXIT
trap 'exit 130' INT TERM
set -- "${1:-}"
smoke_mode=$1
set --
if [ "$smoke_mode" = --smoke ]; then set -- --single-process; fi
"$package_root/Butler.app/Contents/MacOS/Butler" "$@" >"$test_home/app.log" 2>"$test_home/app-error.log" &
app_pid=$!
printf 'Test app PID: %s; port: %s\n' "$app_pid" "$BUTLER_APP_SERVER_PORT"
if [ "$smoke_mode" = --smoke ]; then
  python3 - "$BUTLER_DATA" "$app_pid" "$BUTLER_APP_SERVER_PORT" "$test_home/app.log" <<'PY'
import json, os, pathlib, sys, time, urllib.request
data, pid, port = pathlib.Path(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
log = pathlib.Path(sys.argv[4])
deadline = time.monotonic() + 60
while time.monotonic() < deadline:
    os.kill(pid, 0)
    try:
        token = json.loads((data/'app/runtime/auth/local-agent-auth.json').read_text())['token']
        req = urllib.request.Request(f'http://127.0.0.1:{port}/health', headers={'Authorization':f'Bearer {token}'})
        with urllib.request.urlopen(req, timeout=1) as response:
            assert response.status == 200
        instance = json.loads((data/'app/runtime/foreground/instance.json').read_text())
        assert instance['app_pid'] == pid and instance['state'] == 'ready'
        assert 'Test renderer connected; authenticated sessions=200' in log.read_text()
        print('Test app connected; authenticated renderer sessions=200; Agent health=200')
        break
    except (OSError, ValueError, KeyError, AssertionError):
        time.sleep(.2)
else:
    raise SystemExit('Test app did not connect within 60 seconds')
PY
else
  wait "$app_pid"
fi
