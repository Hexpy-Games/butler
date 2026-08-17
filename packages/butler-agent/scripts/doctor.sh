#!/usr/bin/env bash
# butler doctor — standalone diagnostic CLI
# Runs 8 health checks and outputs a pass/fail report.
# Bash-only: works even when bun is broken.

set -uo pipefail

BUTLER_HOME="${BUTLER_HOME:-$HOME/butler}"
BUTLER_DATA="${BUTLER_DATA:-$HOME/.butler}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/lib/butler-runtime.sh" ]]; then
  # shellcheck source=lib/butler-runtime.sh
  source "$SCRIPT_DIR/lib/butler-runtime.sh"
fi

# ─── CLI flags ─────────────────────────────────────────────────────
JSON_MODE=false
VERBOSE=false
QUIET=false
CHECK_FILTER=""
COLLECT_LOGS=false
GITHUB_MODE=false
FIX_MODE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json)         JSON_MODE=true; shift ;;
    --verbose)      VERBOSE=true; shift ;;
    --quiet)        QUIET=true; shift ;;
    --check)        CHECK_FILTER="$2"; shift 2 ;;
    --collect-logs) COLLECT_LOGS=true; shift ;;
    --github)       GITHUB_MODE=true; shift ;;
    --fix)          FIX_MODE=true; shift ;;
    --help)         echo "Usage: doctor.sh [--json] [--verbose] [--quiet] [--check <name>] [--collect-logs] [--github] [--fix]"; exit 0 ;;
    *)              shift ;;
  esac
done

# ─── Colors ────────────────────────────────────────────────────────
if [[ -t 1 ]] && ! $JSON_MODE; then
  C_RESET='\033[0m'; C_BOLD='\033[1m'; C_DIM='\033[2m'
  C_GREEN='\033[32m'; C_YELLOW='\033[33m'; C_RED='\033[31m'
else
  C_RESET=''; C_BOLD=''; C_DIM=''; C_GREEN=''; C_YELLOW=''; C_RED=''
fi

# ─── Result storage ───────────────────────────────────────────────
declare -a RESULTS=()  # "name|key|status|message|details|fix"
PASS_N=0; WARN_N=0; FAIL_N=0

add_result() {
  local name="$1" key="$2" status="$3" message="$4" details="${5:-}" fix="${6:-}"
  RESULTS+=("${name}|${key}|${status}|${message}|${details}|${fix}")
  case "$status" in
    PASS) PASS_N=$((PASS_N + 1)) ;;
    WARN) WARN_N=$((WARN_N + 1)) ;;
    FAIL|ERR!) FAIL_N=$((FAIL_N + 1)) ;;
  esac
}

# ─── Helpers ───────────────────────────────────────────────────────
load_env_var() {
  local key="$1" file="$BUTLER_DATA/.env"
  [[ -f "$file" ]] || return 1
  local val
  val=$(grep -E "^${key}=" "$file" 2>/dev/null | head -1 | cut -d= -f2-)
  # Strip surrounding quotes
  val="${val%\"}" ; val="${val#\"}"
  val="${val%\'}" ; val="${val#\'}"
  # trim leading/trailing whitespace via parameter expansion
  val="${val#"${val%%[![:space:]]*}"}"
  val="${val%"${val##*[![:space:]]}"}"
  [[ -n "$val" ]] && echo "$val" || return 1
}

format_bytes() {
  local bytes=$1
  if (( bytes < 1024 )); then echo "${bytes}B"
  elif (( bytes < 1048576 )); then echo "$(( bytes / 1024 ))KB"
  elif (( bytes < 1073741824 )); then echo "$(( bytes / 1048576 ))MB"
  else echo "$(( bytes / 1073741824 ))GB"; fi
}

read_runtime_mode() {
  local config_path="$BUTLER_DATA/butler.config.json"
  local runtime="${BUTLER_RUNTIME:-}"
  if [[ -n "$runtime" ]]; then
    echo "$runtime"
    return 0
  fi
  if [[ -f "$config_path" ]]; then
    runtime="$(jq -r '.system.runtime // empty' "$config_path" 2>/dev/null || true)"
  fi
  if [[ -n "$runtime" ]]; then
    echo "$runtime"
  else
    echo "codex-api"
  fi
}

# ─── Check 1: Dependencies ────────────────────────────────────────
check_dependencies() {
  local status="PASS" details="" missing="" fixes=""
  local runtime_mode
  runtime_mode="$(read_runtime_mode)"

  local bun_path="" bun_ver="" pinned=""
  pinned="$(butler_bun_pinned_version 2>/dev/null || echo "unknown")"
  bun_path="$(butler_resolve_bun 2>/dev/null || true)"
  if [[ -z "$bun_path" ]]; then
    missing="${missing:+$missing, }Butler runtime"
    status="FAIL"
    details="${details}Butler runtime: NOT FOUND\n"
    fixes="${fixes}Run install.sh to repair the managed Butler runtime, or set BUTLER_BUN=/path/to/bun\n"
  else
    bun_ver="$("$bun_path" --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+[.0-9]*' | head -1 || echo '?')"
    details="${details}Butler runtime: ${bun_ver:-?} (${bun_path})\n"
    if [[ "$pinned" != "unknown" && "$bun_ver" != "$pinned" ]]; then
      [[ "$status" == "PASS" ]] && status="WARN"
      details="${details}Butler runtime pinned version: $pinned\n"
      fixes="${fixes}Run install.sh to repair the managed Butler runtime\n"
    fi
  fi

  # Optional: gum
  local gum_path
  gum_path="$(command -v gum 2>/dev/null || true)"
  if [[ -z "$gum_path" ]]; then
    [[ "$status" == "PASS" ]] && status="WARN"
    details="${details}gum: not found (optional)\n"
  else
    local gum_ver
    gum_ver="$(gum --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+[.0-9]*' | head -1 || echo '?')"
    details="${details}gum: ${gum_ver} (${gum_path})\n"
  fi

  local msg
  if [[ "$status" == "FAIL" ]]; then
    msg="missing: $missing"
  else
    msg="$(echo -e "$details" | grep -v 'optional' | grep -v '^$' | sed 's/(.*//' | awk -F: '{printf "%s %s, ", $1, $2}' | sed 's/, $//')"
  fi

  add_result "dependencies" "dependencies" "$status" "$msg" "$details" "$fixes"
}

# ─── Check 2: Environment ─────────────────────────────────────────
check_environment() {
  local status="PASS" details="" fixes=""
  local env_file="$BUTLER_DATA/.env"

  if [[ ! -f "$env_file" ]]; then
    add_result "environment" "environment" "FAIL" ".env file not found" "expected: $env_file" "Run install wizard or create .env manually"
    return
  fi

  local auth_mode="missing"
  if [[ -n "$(load_env_var OPENAI_API_KEY 2>/dev/null || true)" ]]; then
    auth_mode="api_key"
    details="${details}OPENAI_API_KEY: set\n"
  elif [[ -f "${BUTLER_CODEX_AUTH_PROFILE:-${BUTLER_OPENAI_AUTH_PROFILE:-$BUTLER_DATA/auth/openai-codex.json}}" ]]; then
    auth_mode="codex_subscription"
    details="${details}Codex subscription auth profile: present\n"
  elif [[ -f "${CODEX_HOME:-$HOME/.codex}/auth.json" ]]; then
    auth_mode="codex_oauth"
    details="${details}CODEX_AUTH_JSON: present\n"
  else
    status="FAIL"
    details="${details}OpenAI auth: missing\n"
    fixes="Run install.sh with Codex subscription login, or add OPENAI_API_KEY=..."
  fi

  local msg
  if [[ "$status" == "FAIL" ]]; then msg="required variables missing"
  else msg=".env present, auth=${auth_mode}"; fi

  add_result "environment" "environment" "$status" "$msg" "$details" "$fixes"
}

# ─── Check 3: Config Validity ─────────────────────────────────────
check_config() {
  local status="PASS" details="" fixes=""
  local config_path="$BUTLER_DATA/butler.config.json"

  if [[ ! -f "$config_path" ]]; then
    status="WARN"
    details="${details}butler.config.json: not found\n"
  else
    # Validate JSON — use python/node/Butler runtime if available, else basic check
    local parser=""
    if command -v python3 &>/dev/null; then parser="python3 -c 'import json,sys; json.load(sys.stdin)'"
    elif command -v node &>/dev/null; then parser="node -e 'JSON.parse(require(\"fs\").readFileSync(\"/dev/stdin\",\"utf8\"))'"
    elif [[ -n "${BUTLER_BUN:-}" ]] || butler_use_runtime 2>/dev/null; then parser="\"$BUTLER_BUN\" -e 'JSON.parse(await Bun.stdin.text())'"
    fi

    if [[ -n "$parser" ]]; then
      if eval "$parser" < "$config_path" 2>/dev/null; then
        details="${details}butler.config.json: valid JSON\n"

        # Verify required fields exist and are non-empty
        local field_errors=""
        if command -v python3 &>/dev/null; then
field_errors="$(python3 -c "
import json, sys, os
config_path = sys.argv[1]
butler_data = sys.argv[2]
with open(config_path) as f:
    cfg = json.load(f)
errors = []
onboarding_pending = False
onboarding_path = os.path.join(butler_data, 'personalization', 'onboarding.json')
try:
    with open(onboarding_path) as f:
        onboarding = json.load(f)
    onboarding_pending = onboarding.get('status') != 'complete'
except Exception:
    onboarding_pending = False
# user.name
name = (cfg.get('user') or {}).get('name', '')
if (not name or name == 'YourName') and not onboarding_pending:
    errors.append('user.name missing or placeholder')
# system.butlerHome
bh = (cfg.get('system') or {}).get('butlerHome', '')
if not bh:
    errors.append('system.butlerHome missing')
runtime = (cfg.get('system') or {}).get('runtime', 'codex-api')
if runtime != 'codex-api':
    errors.append('system.runtime must be codex-api')
# project paths
for p in cfg.get('projects', []):
    path = p.get('path', '')
    if path:
        expanded = os.path.expanduser(path)
        if not os.path.isdir(expanded):
            errors.append('project path not found: ' + path)
print('\n'.join(errors))
" "$config_path" "$BUTLER_DATA" 2>/dev/null || true)"
        fi

        if [[ -n "$field_errors" ]]; then
          status="FAIL"
          while IFS= read -r err; do
            [[ -n "$err" ]] && details="${details}  ${err}\n"
          done <<< "$field_errors"
          fixes="${fixes}Fix required fields in butler.config.json\n"
        fi
      else
        status="FAIL"
        details="${details}butler.config.json: parse error\n"
        fixes="${fixes}Fix JSON syntax in butler.config.json\n"
      fi
    else
      details="${details}butler.config.json: exists (no JSON parser to validate)\n"
    fi
  fi

  local cfg_msg
  [[ -f "$config_path" ]] && cfg_msg="butler.config.json valid" || cfg_msg="butler.config.json not found"

  add_result "config" "config" "$status" "$cfg_msg" "$details" "$fixes"
}

# ─── Check 4: Native Services ─────────────────────────────────────
check_services() {
  local status="PASS" details="" fixes=""
  local control="$BUTLER_HOME/packages/butler-agent/scripts/service-control.sh"
  if [[ ! -x "$control" ]]; then
    add_result "native services" "services" "FAIL" "native service controller missing" "expected: $control" "Reinstall Butler or restore packages/butler-agent/scripts/service-control.sh"
    return
  fi

  if [[ -z "${BUTLER_BUN:-}" ]]; then
    butler_use_runtime 2>/dev/null || true
  fi
  if [[ -z "${BUTLER_BUN:-}" ]]; then
    add_result "native services" "services" "WARN" "cannot inspect services without Butler runtime" "" "Run install.sh to repair the managed Butler runtime"
    return
  fi

  local payload
  payload="$("$control" ps --json 2>/dev/null || true)"
  if [[ -z "$payload" ]]; then
    add_result "native services" "services" "FAIL" "native service status unavailable" "" "Run butler start"
    return
  fi

  local online_count=0
  local service_names total_count
  service_names=$(echo "$payload" | "$BUTLER_BUN" -e "
    const payload = JSON.parse(await Bun.stdin.text());
    console.log((payload.services ?? [])
      .map((service) => service.serviceId || service.name)
      .filter(Boolean)
      .join('\\n'));
  " 2>/dev/null || true)
  total_count=$(echo "$service_names" | sed '/^$/d' | wc -l | tr -d ' ')
  if [[ "$total_count" == "0" ]]; then
    add_result "native services" "services" "FAIL" "native service status returned no services" "" "Run butler start"
    return
  fi
  while IFS= read -r proc_name; do
    [[ -n "$proc_name" ]] || continue
    local proc_status
    proc_status=$(echo "$payload" | "$BUTLER_BUN" -e "
      const payload = JSON.parse(await Bun.stdin.text());
      const p = payload.services?.find(x => (x.serviceId || x.name) === '$proc_name');
      if (!p) { console.log('MISSING'); process.exit(0); }
      console.log(p.status || 'unknown');
    " 2>/dev/null || echo "unknown")

    if [[ "$proc_status" == "MISSING" ]]; then
      status="FAIL"
      details="${details}${proc_name}: NOT REGISTERED\n"
      fixes="butler start"
    else
      if [[ "$proc_status" == "stale" ]]; then
        status="FAIL"
        details="${details}${proc_name}: STALE\n"
        fixes="butler restart"
      elif [[ "$proc_status" == "offline" ]]; then
        status="FAIL"
        details="${details}${proc_name}: OFFLINE\n"
        fixes="butler start"
      else
        details="${details}${proc_name}: ${proc_status}\n"
        [[ "$proc_status" == "online" ]] && online_count=$((online_count + 1))
      fi
    fi
  done <<< "$service_names"

  add_result "native services" "services" "$status" "${online_count}/${total_count} services healthy" "$details" "$fixes"
}

# ─── Check 6: Embed Server Health ─────────────────────────────────
check_embed() {
  local socket_path="${EMBED_SOCKET:-/tmp/butler-embed.sock}"
  local port="${EMBED_HEALTH_PORT:-9847}"
  local discovery_path="${socket_path}.health-port"

  embed_health_response_ok() {
    local response="$1"
    local http_code="${response##*$'\n'}"
    local body="${response%$'\n'*}"
    [[ "$http_code" =~ ^2[0-9][0-9]$ ]] || return 1
    [[ "$body" =~ \"status\"[[:space:]]*:[[:space:]]*\"(ready|busy)\" ]]
  }

  # Try HTTP health check
  if command -v curl &>/dev/null; then
    local -a candidate_ports=()
    if [[ "$port" =~ ^[0-9]+$ ]] && (( port > 0 )); then
      candidate_ports+=("$port")
    fi
    if [[ -r "$discovery_path" ]]; then
      local discovered_port
      discovered_port="$(tr -dc '0-9' < "$discovery_path" 2>/dev/null || true)"
      if [[ "$discovered_port" =~ ^[0-9]+$ ]] && (( discovered_port > 0 )); then
        if [[ " ${candidate_ports[*]} " != *" $discovered_port "* ]]; then
          candidate_ports+=("$discovered_port")
        fi
      fi
    fi

    local candidate resp
    for candidate in "${candidate_ports[@]}"; do
      resp="$(curl -sS --max-time 5 -w $'\n%{http_code}' "http://127.0.0.1:${candidate}/health" 2>/dev/null || true)"
      if embed_health_response_ok "$resp"; then
        add_result "embed server" "embed" "PASS" "responding on port $candidate" "port: $candidate" ""
        return
      fi
    done

    # Try Unix socket, including when HTTP used a discovered fallback port.
    if [[ -e "$socket_path" ]]; then
      resp="$(curl -sS --max-time 5 -w $'\n%{http_code}' --unix-socket "$socket_path" "http://localhost/health" 2>/dev/null || true)"
      if embed_health_response_ok "$resp"; then
        add_result "embed server" "embed" "PASS" "responding on socket" "socket: $socket_path" ""
        return
      fi
    fi
  fi

  add_result "embed server" "embed" "FAIL" "not responding" "Neither socket nor HTTP health check responded" "butler restart"
}

# ─── Check 7: File Permissions ────────────────────────────────────
check_permissions() {
  local status="PASS" details="" fixes=""
  local exec_count=0

  for script in packages/butler-agent/scripts/start-butler.sh; do
    local full="$BUTLER_HOME/$script"
    [[ -f "$full" ]] || continue
    if [[ -x "$full" ]]; then
      exec_count=$((exec_count + 1))
    else
      status="FAIL"
      details="${details}${script}: NOT EXECUTABLE\n"
      fixes="${fixes}chmod +x $full\n"
    fi
  done

  # Check hooks
  local hooks_dir="$BUTLER_HOME/packages/butler-agent/scripts/hooks"
  if [[ -d "$hooks_dir" ]]; then
    while IFS= read -r hook; do
      [[ -z "$hook" ]] && continue
      if [[ -x "$hook" ]]; then
        exec_count=$((exec_count + 1))
      else
        status="FAIL"
        local rel="${hook#$BUTLER_HOME/}"
        details="${details}${rel}: NOT EXECUTABLE\n"
        fixes="${fixes}chmod +x $hook\n"
      fi
    done < <(find "$hooks_dir" -name "*.sh" 2>/dev/null)
  fi

  [[ "$status" == "PASS" ]] && details="${details}${exec_count} scripts executable\n"

  # Check data dirs writable
  for dir in "$BUTLER_DATA" "$BUTLER_DATA/tasks"; do
    if [[ ! -d "$dir" ]]; then
      [[ "$status" == "PASS" ]] && status="WARN"
      local rel="${dir#$BUTLER_HOME/}"
      details="${details}${rel}: does not exist\n"
      fixes="${fixes}mkdir -p $dir\n"
    elif [[ ! -w "$dir" ]]; then
      status="FAIL"
      local rel="${dir#$BUTLER_HOME/}"
      details="${details}${rel}: NOT WRITABLE\n"
      fixes="${fixes}chmod 755 $dir\n"
    else
      local rel="${dir#$BUTLER_HOME/}"
      details="${details}${rel}: writable\n"
    fi
  done

  local msg
  [[ "$status" == "PASS" ]] && msg="${exec_count} scripts executable, data/ writable" || msg="permission issues found"
  add_result "file permissions" "permissions" "$status" "$msg" "$details" "$fixes"
}

# ─── Check 8: Disk Space ──────────────────────────────────────────
check_disk() {
  local status="PASS" details=""

  # Available disk space (portable: works on macOS + Linux)
  local avail_kb=0
  if command -v df &>/dev/null; then
    avail_kb=$(df -k "$BUTLER_HOME" 2>/dev/null | awk 'NR==2{print $4}')
    avail_kb="${avail_kb:-0}"
  fi
  local avail_bytes=$(( avail_kb * 1024 ))
  details="${details}available: $(format_bytes $avail_bytes)\n"

  if (( avail_bytes < 209715200 )); then  # < 200MB
    status="FAIL"
  elif (( avail_bytes < 1073741824 )); then  # < 1GB
    status="WARN"
  fi

  # Tasks dir
  local tasks_dir="$BUTLER_DATA/tasks"
  if [[ -d "$tasks_dir" ]]; then
    local tasks_kb
    tasks_kb=$(du -sk "$tasks_dir" 2>/dev/null | awk '{print $1}')
    tasks_kb="${tasks_kb:-0}"
    local tasks_bytes=$(( tasks_kb * 1024 ))
    details="${details}tasks dir: $(format_bytes $tasks_bytes)\n"

    if (( tasks_bytes > 1073741824 )); then
      status="FAIL"
      details="${details}tasks dir exceeds 1GB — cleanup needed\n"
    elif (( tasks_bytes > 536870912 )); then
      [[ "$status" == "PASS" ]] && status="WARN"
      details="${details}tasks dir exceeds 500MB — consider cleanup\n"
    fi

    # Count tasks
    local task_count
    task_count=$(ls -1 "$tasks_dir" 2>/dev/null | wc -l | tr -d ' ')
    details="${details}task count: $task_count\n"

    if (( task_count > 500 )); then
      status="FAIL"
    elif (( task_count > 200 )); then
      [[ "$status" == "PASS" ]] && status="WARN"
    fi
  fi

  # Logs dir
  local logs_dir="$BUTLER_DATA/logs"
  if [[ -d "$logs_dir" ]]; then
    local logs_kb
    logs_kb=$(du -sk "$logs_dir" 2>/dev/null | awk '{print $1}')
    logs_kb="${logs_kb:-0}"
    details="${details}logs dir: $(format_bytes $(( logs_kb * 1024 )))\n"
  fi

  local msg
  if [[ "$status" == "PASS" ]]; then msg="$(format_bytes $avail_bytes) free"
  elif [[ "$status" == "WARN" ]]; then msg="low disk space: $(format_bytes $avail_bytes) free"
  else msg="critically low: $(format_bytes $avail_bytes) free"; fi

  add_result "disk space" "disk" "$status" "$msg" "$details" ""
}

# ─── Check 9: Steward Health ─────────────────────────────────────
check_steward() {
  local status="PASS" details="" msg=""
  local runtime_mode
  runtime_mode="$(read_runtime_mode)"

  local pointer_dir="$BUTLER_DATA/config/subsession-sessions"
  if [[ -d "$pointer_dir" ]]; then
    local native_count
    native_count="$(find "$pointer_dir" -maxdepth 1 -name '*.txt' -type f | wc -l | tr -d ' ')"
    if [[ "${native_count:-0}" -gt 0 ]]; then
      status="WARN"
      details="${details}native steward session pointers found: $native_count\n"
    fi
  fi

  # Check session-id.txt
  local session_file="$BUTLER_DATA/config/session-id.txt"
  if [[ ! -f "$session_file" ]] || [[ ! -s "$session_file" ]]; then
    [[ "$status" == "PASS" ]] && status="WARN"
    details="${details}session-id.txt: missing or empty\n"
  else
    details="${details}session-id.txt: present\n"
  fi

  [[ "$status" == "PASS" ]] && msg="no concurrent steward detected" || msg="steward-related issues detected"
  add_result "steward" "steward" "$status" "$msg" "$details" ""
}

# ─── Check 10: Worker Health (Zombies / Stuck) ──────────────────
check_workers() {
  local status="PASS" details="" msg=""
  local total=0 done_count=0 failed_count=0 running_count=0 zombie_count=0 stuck_count=0

  local tasks_dir="$BUTLER_DATA/tasks"
  if [[ ! -d "$tasks_dir" ]]; then
    add_result "workers" "workers" "PASS" "no tasks directory" "" ""
    return
  fi

  for status_file in "$tasks_dir"/*/status; do
    [[ -f "$status_file" ]] || continue
    total=$((total + 1))
    local task_status
    task_status="$(cat "$status_file" 2>/dev/null || echo "")"
    local task_dir
    task_dir="$(dirname "$status_file")"

    case "$task_status" in
      DONE)    done_count=$((done_count + 1)) ;;
      FAILED)  failed_count=$((failed_count + 1)) ;;
      RUNNING)
        running_count=$((running_count + 1))
        local pid_file="$task_dir/pid"
        local task_pid=""
        [[ -f "$pid_file" ]] && task_pid="$(cat "$pid_file" 2>/dev/null || echo "")"

        if [[ -z "$task_pid" ]] || ! kill -0 "$task_pid" 2>/dev/null; then
          # Zombie: RUNNING but process dead
          zombie_count=$((zombie_count + 1))
          local task_id
          task_id="$(basename "$task_dir")"
          details="${details}zombie: $task_id (pid=${task_pid:-missing})\n"
        else
          # Check if stuck (running > 30 min) — use the older of dir or status mtime
          local mtime_epoch=0 mtime_dir=0 mtime_status=0
          case "$(uname -s)" in
            Darwin)
              mtime_dir=$(stat -f %m "$task_dir" 2>/dev/null || echo 0)
              mtime_status=$(stat -f %m "$task_dir/status" 2>/dev/null || echo 0)
              ;;
            *)
              mtime_dir=$(stat -c %Y "$task_dir" 2>/dev/null || echo 0)
              mtime_status=$(stat -c %Y "$task_dir/status" 2>/dev/null || echo 0)
              ;;
          esac
          # Use whichever is older (smaller epoch)
          if [[ "$mtime_status" -gt 0 && "$mtime_status" -lt "$mtime_dir" ]]; then
            mtime_epoch=$mtime_status
          else
            mtime_epoch=$mtime_dir
          fi
          local now_epoch
          now_epoch=$(date +%s)
          local age_min=$(( (now_epoch - mtime_epoch) / 60 ))
          if [[ "$age_min" -gt 30 ]]; then
            stuck_count=$((stuck_count + 1))
            local task_id
            task_id="$(basename "$task_dir")"
            details="${details}stuck: $task_id (running ${age_min}min, pid=$task_pid)\n"
          fi
        fi
        ;;
    esac
  done

  details="${details}total=$total done=$done_count failed=$failed_count running=$running_count zombie=$zombie_count stuck=$stuck_count\n"

  if [[ "$zombie_count" -gt 0 ]]; then
    status="FAIL"
    msg="${zombie_count} zombie worker(s) detected"
  elif [[ "$stuck_count" -gt 0 ]]; then
    status="WARN"
    msg="${stuck_count} stuck worker(s) (>30min)"
  elif [[ "$running_count" -gt 5 ]]; then
    status="WARN"
    msg="unusually many workers running: $running_count"
  else
    msg="${running_count} running, ${done_count} done, ${failed_count} failed"
  fi

  add_result "workers" "workers" "$status" "$msg" "$details" ""
}

# ─── Check 11: Delivery Queue ─────────────────────────────────────
check_delivery() {
  local status="PASS" details="" msg=""
  local queue_dir="$BUTLER_DATA/runtime/task-notifications"
  local pending=0 failed=0 delivered=0 last_error=""

  if [[ ! -d "$queue_dir" ]]; then
    add_result "delivery" "delivery" "PASS" "no delivery backlog" "" ""
    return
  fi

  for notification_file in "$queue_dir"/*.json; do
    [[ -f "$notification_file" ]] || continue
    local notification_status notification_error
    notification_status="$(jq -r '.status // "unknown"' "$notification_file" 2>/dev/null || echo "unknown")"
    notification_error="$(jq -r '.lastError // empty' "$notification_file" 2>/dev/null || true)"
    case "$notification_status" in
      pending) pending=$((pending + 1)) ;;
      failed)
        failed=$((failed + 1))
        [[ -n "$notification_error" ]] && last_error="$notification_error"
        ;;
      delivered) delivered=$((delivered + 1)) ;;
    esac
  done

  details="${details}pending=$pending failed=$failed delivered=$delivered\n"
  [[ -n "$last_error" ]] && details="${details}last_error=$last_error\n"

  if [[ "$failed" -gt 0 ]]; then
    status="WARN"
    msg="$failed failed delivery notification(s), retryable by monitor"
  elif [[ "$pending" -gt 0 ]]; then
    status="WARN"
    msg="$pending pending delivery notification(s)"
  else
    msg="no delivery backlog"
  fi

  add_result "delivery" "delivery" "$status" "$msg" "$details" ""
}

# ─── Check 12: Hook Integrity ───────────────────────────────────
check_hooks() {
  local status="PASS" details="" msg=""
  local hooks_checked=0 issues=0

  local hook_dirs=()
  if [[ ${#hook_dirs[@]} -eq 0 ]]; then
    add_result "hooks" "hooks" "PASS" "no hooks.json files found" "" ""
    return
  fi

  for hooks_dir in "${hook_dirs[@]}"; do
    local hooks_json="$hooks_dir/hooks.json"
    [[ -f "$hooks_json" ]] || continue
    hooks_checked=$((hooks_checked + 1))

    # Validate JSON parseable
    if ! python3 -c "import json; json.load(open('$hooks_json'))" 2>/dev/null && \
       ! jq . "$hooks_json" >/dev/null 2>&1; then
      status="FAIL"
      issues=$((issues + 1))
      details="${details}FAIL: $hooks_json is not valid JSON\n"
      continue
    fi

    # Extract command paths from hooks.json
    local commands=""
    if command -v python3 &>/dev/null; then
      commands="$(python3 -c "
import json, sys
try:
    with open('$hooks_json') as f:
        data = json.load(f)
    hooks = data.get('hooks', {})
    for event_name, event_list in hooks.items():
        if isinstance(event_list, list):
            for entry in event_list:
                hook_list = entry.get('hooks', []) if isinstance(entry, dict) else []
                for h in hook_list:
                    if isinstance(h, dict) and h.get('type') == 'command':
                        cmd = h.get('command', '')
                        if cmd:
                            print(cmd.split()[0])
except Exception:
    pass
" 2>/dev/null || true)"
    fi

    if [[ -n "$commands" ]]; then
      while IFS= read -r script_path; do
        [[ -z "$script_path" ]] && continue
        if [[ ! -f "$script_path" ]]; then
          status="FAIL"
          issues=$((issues + 1))
          details="${details}FAIL: referenced script missing: $script_path\n"
        elif [[ ! -x "$script_path" ]]; then
          status="FAIL"
          issues=$((issues + 1))
          details="${details}FAIL: referenced script not executable: $script_path\n"
        else
          details="${details}OK: $script_path\n"
        fi
      done <<< "$commands"
    fi
  done

  if [[ "$hooks_checked" -eq 0 ]]; then
    msg="no hooks.json files found"
  elif [[ "$status" == "PASS" ]]; then
    msg="$hooks_checked hooks.json files valid"
  else
    msg="$issues hook integrity issue(s)"
  fi

  add_result "hooks" "hooks" "$status" "$msg" "$details" ""
}

# ─── Check 13: Log Health ───────────────────────────────────────
check_logs() {
  local status="PASS" details="" msg=""
  local log_dir="$BUTLER_DATA/logs"
  local expected_logs=(hooks.log tasks.log system.log)
  local missing=0 oversized=0

  for log_name in "${expected_logs[@]}"; do
    local log_file="$log_dir/$log_name"
    if [[ ! -f "$log_file" ]]; then
      [[ "$status" == "PASS" ]] && status="WARN"
      missing=$((missing + 1))
      details="${details}WARN: $log_name missing (first run?)\n"
    else
      local file_size
      file_size=$(wc -c < "$log_file" 2>/dev/null || echo 0)
      file_size=$(echo "$file_size" | tr -d ' ')
      if [[ "$file_size" -gt 52428800 ]]; then  # > 50MB
        [[ "$status" == "PASS" || "$status" == "WARN" ]] && status="WARN"
        oversized=$((oversized + 1))
        details="${details}WARN: $log_name exceeds 50MB ($(( file_size / 1048576 ))MB)\n"
      else
        details="${details}OK: $log_name ($(( file_size / 1024 ))KB)\n"
      fi
    fi
  done

  # Check session-sync.log specifically
  local ss_log="$log_dir/session-sync.log"
  if [[ -f "$ss_log" ]]; then
    local ss_size
    ss_size=$(wc -c < "$ss_log" 2>/dev/null || echo 0)
    ss_size=$(echo "$ss_size" | tr -d ' ')
    if [[ "$ss_size" -gt 10485760 ]]; then  # > 10MB
      [[ "$status" == "PASS" ]] && status="WARN"
      details="${details}WARN: session-sync.log exceeds 10MB ($(( ss_size / 1048576 ))MB)\n"
    fi
  fi

  # Total log dir size
  if [[ -d "$log_dir" ]]; then
    local total_kb
    total_kb=$(du -sk "$log_dir" 2>/dev/null | awk '{print $1}')
    total_kb="${total_kb:-0}"
    local total_bytes=$(( total_kb * 1024 ))
    details="${details}total log dir: $(( total_bytes / 1048576 ))MB\n"

    if [[ "$total_bytes" -gt 209715200 ]]; then  # > 200MB
      status="FAIL"
      details="${details}FAIL: total log dir exceeds 200MB\n"
    elif [[ "$total_bytes" -gt 104857600 ]]; then  # > 100MB
      [[ "$status" == "PASS" ]] && status="WARN"
      details="${details}WARN: total log dir exceeds 100MB\n"
    fi
  fi

  if [[ "$missing" -gt 0 ]]; then
    msg="$missing expected log file(s) missing"
  elif [[ "$oversized" -gt 0 ]]; then
    msg="$oversized log file(s) oversized"
  elif [[ "$status" == "FAIL" ]]; then
    msg="total log dir too large"
  else
    msg="log health OK"
  fi

  add_result "logs" "logs" "$status" "$msg" "$details" ""
}

# ─── --collect-logs implementation ───────────────────────────────
do_collect_logs() {
  # Guard against path traversal in BUTLER_DATA
  [[ "$BUTLER_DATA" == *..* ]] && { echo "Invalid BUTLER_DATA path: contains '..'"; exit 1; }
  if [[ -n "$BUTLER_DATA" ]]; then
    local _real_data
    _real_data="$(cd "$BUTLER_DATA" 2>/dev/null && pwd -P 2>/dev/null || true)"
    if [[ -z "$_real_data" ]]; then
      # Directory doesn't exist yet — validate the string form instead
      _real_data="$(cd "$(dirname "$BUTLER_DATA")" 2>/dev/null && echo "$(pwd -P)/$(basename "$BUTLER_DATA")" || true)"
    fi
    [[ "$_real_data" == *..* ]] && { echo "Invalid BUTLER_DATA path: resolves with traversal"; exit 1; }
  fi

  local ts
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  local bundle_name="butler-diagnostics-${ts}"
  local bundle_dir="/tmp/${bundle_name}"
  local bundle_path="/tmp/${bundle_name}.tar.gz"

  mkdir -p "$bundle_dir/logs" "$bundle_dir/config"

  # system-info.txt
  {
    echo "date: $(date -u)"
    echo "hostname: $(hostname 2>/dev/null || echo unknown)"
    echo "uname: $(uname -a 2>/dev/null || echo unknown)"
    echo "PATH: $PATH"
  } > "$bundle_dir/system-info.txt"

  # Sanitize function (portable: no sed -i)
  _sanitize_file() {
    local file="$1"
    [[ -f "$file" ]] || return 0
    local tmp="${file}.sanitize.tmp"
    sed \
      -e 's/sk-ant-[a-zA-Z0-9_-]*/sk-ant-REDACTED/g' \
      -e 's/[0-9]\{8,\}:[A-Za-z0-9_-]\{35,\}/BOT_TOKEN_REDACTED/g' \
      -e 's/\(ANTHROPIC_API_KEY=\).*/\1REDACTED/g' \
      "$file" > "$tmp" 2>/dev/null && mv "$tmp" "$file" || rm -f "$tmp"
  }

  # Native service state
  if [[ -x "$BUTLER_HOME/packages/butler-agent/scripts/service-control.sh" ]]; then
    "$BUTLER_HOME/packages/butler-agent/scripts/service-control.sh" ps --json > "$bundle_dir/native-services.json" 2>/dev/null || echo '{"services":[]}' > "$bundle_dir/native-services.json"
  else
    echo '{"services":[]}' > "$bundle_dir/native-services.json"
  fi
  _sanitize_file "$bundle_dir/native-services.json"

  # Copy log files (last 24h or last 100 lines)
  local today_prefix
  today_prefix="$(date -u +%Y-%m-%d)"
  for log_name in hooks.log tasks.log system.log; do
    local src="$BUTLER_DATA/logs/$log_name"
    if [[ -f "$src" ]]; then
      local filtered
      filtered="$(grep "^\[${today_prefix}" "$src" 2>/dev/null || true)"
      if [[ -n "$filtered" ]]; then
        echo "$filtered" > "$bundle_dir/logs/$log_name"
      else
        tail -n 100 "$src" > "$bundle_dir/logs/$log_name" 2>/dev/null || true
      fi
    fi
  done

  # doctor.log — full
  [[ -f "$BUTLER_DATA/logs/doctor.log" ]] && cp "$BUTLER_DATA/logs/doctor.log" "$bundle_dir/logs/" 2>/dev/null || true
  # daily-reset.log — last 500 lines
  [[ -f "$BUTLER_DATA/logs/daily-reset.log" ]] && tail -n 500 "$BUTLER_DATA/logs/daily-reset.log" > "$bundle_dir/logs/daily-reset.log" 2>/dev/null || true
  # session-sync.log — last 200 lines
  [[ -f "$BUTLER_DATA/logs/session-sync.log" ]] && tail -n 200 "$BUTLER_DATA/logs/session-sync.log" > "$bundle_dir/logs/session-sync.log" 2>/dev/null || true

  # Config (sanitized)
  [[ -f "$BUTLER_DATA/butler.config.json" ]] && cp "$BUTLER_DATA/butler.config.json" "$bundle_dir/config/" 2>/dev/null || true
  [[ -f "$BUTLER_HOME/butler.config.json" ]] && cp "$BUTLER_HOME/butler.config.json" "$bundle_dir/config/" 2>/dev/null || true

  # Sanitize all files in bundle
  while IFS= read -r f; do
    _sanitize_file "$f"
  done < <(find "$bundle_dir" -type f 2>/dev/null)

  # Create tar.gz
  tar -czf "$bundle_path" -C /tmp "$bundle_name" 2>/dev/null

  # Cleanup temp dir
  rm -rf "$bundle_dir" 2>/dev/null || true

  echo "$bundle_path"
}

# ─── --github implementation ─────────────────────────────────────
do_github() {
  if ! command -v gh &>/dev/null; then
    echo "gh CLI is not installed. Install from https://cli.github.com/"
    exit 1
  fi

  if ! gh auth status &>/dev/null 2>&1; then
    echo "gh is not authenticated. Run: gh auth login"
    exit 1
  fi

  # First collect logs
  local bundle_path
  bundle_path="$(do_collect_logs)"
  echo "Bundle created: $bundle_path"

  # Create draft issue
  local title="[bug] Doctor report: $(date -u +%Y-%m-%d)"
  local body
  body="$(cat <<GHEOF
## Doctor Report

Generated: $(date -u)

### Diagnostic Bundle
Path: $bundle_path
> Please attach the bundle file manually (GitHub CLI does not support binary attachments).

### Notes
- Run \`butler doctor --verbose\` for detailed check output
GHEOF
)"

  gh issue create --draft --title "$title" --body "$body"
  exit 0
}

# ─── --fix implementation ────────────────────────────────────────
do_fix() {
  local fixed=0

  # Fix 1: Zombie workers — mark dead RUNNING tasks as FAILED
  local tasks_dir="$BUTLER_DATA/tasks"
  if [[ -d "$tasks_dir" ]]; then
    for status_file in "$tasks_dir"/*/status; do
      [[ -f "$status_file" ]] || continue
      local task_status
      task_status="$(cat "$status_file" 2>/dev/null || echo "")"
      if [[ "$task_status" == "RUNNING" ]]; then
        local task_dir
        task_dir="$(dirname "$status_file")"
        local pid_file="$task_dir/pid"
        local task_pid=""
        [[ -f "$pid_file" ]] && task_pid="$(cat "$pid_file" 2>/dev/null || echo "")"

        # Only fix if PID is dead (not alive)
        if [[ -z "$task_pid" ]] || ! kill -0 "$task_pid" 2>/dev/null; then
          echo "FAILED" > "$status_file"
          local task_id
          task_id="$(basename "$task_dir")"
          echo "Fixed zombie: $task_id (marked FAILED)"
          fixed=$((fixed + 1))
        fi
      fi
    done
  fi

  # Fix 2: Non-executable scripts
  if [[ -d "$BUTLER_HOME/packages/butler-agent/scripts" ]]; then
    for script in "$BUTLER_HOME/packages/butler-agent/scripts"/*.sh; do
      [[ -f "$script" ]] || continue
      if [[ ! -x "$script" ]]; then
        chmod +x "$script"
        echo "Fixed permissions: $script"
        fixed=$((fixed + 1))
      fi
    done
  fi

  # Fix 3: Oversized log files
  local log_dir="$BUTLER_DATA/logs"
  if [[ -d "$log_dir" ]]; then
    for log_file in "$log_dir"/*.log; do
      [[ -f "$log_file" ]] || continue
      local file_size
      file_size=$(wc -c < "$log_file" 2>/dev/null || echo 0)
      file_size=$(echo "$file_size" | tr -d ' ')
      if [[ "$file_size" -gt 52428800 ]]; then  # > 50MB
        tail -n 5000 "$log_file" > "${log_file}.tmp" && mv "${log_file}.tmp" "$log_file"
        echo "Fixed oversized log: $(basename "$log_file")"
        fixed=$((fixed + 1))
      fi
    done
  fi

  echo "Applied $fixed fix(es)"
  exit 0
}

# ─── Output ────────────────────────────────────────────────────────
print_human() {
  echo ""
  echo -e "${C_BOLD}butler doctor${C_RESET}"
  echo "══════════════"
  echo ""

  for entry in "${RESULTS[@]}"; do
    IFS='|' read -r name key st msg details fix <<< "$entry"

    $QUIET && [[ "$st" == "PASS" ]] && continue

    local color
    case "$st" in
      PASS) color="$C_GREEN" ;;
      WARN) color="$C_YELLOW" ;;
      *)    color="$C_RED" ;;
    esac

    printf "${color}[%s]${C_RESET} %-20s — %s\n" "$st" "$name" "$msg"

    if $VERBOSE && [[ -n "$details" ]]; then
      echo -e "$details" | while IFS= read -r line; do
        [[ -n "$line" ]] && echo -e "${C_DIM}     ${line}${C_RESET}"
      done
    fi

    if [[ "$st" == "FAIL" && -n "$fix" ]]; then
      echo -e "$fix" | while IFS= read -r line; do
        [[ -n "$line" ]] && echo -e "${C_DIM}     fix: ${line}${C_RESET}"
      done
    fi
  done

  echo ""
  echo -e "Summary: ${C_GREEN}${PASS_N} passed${C_RESET}, ${C_YELLOW}${WARN_N} warning$( (( WARN_N != 1 )) && echo s)${C_RESET}, ${C_RED}${FAIL_N} failed${C_RESET}"
}

print_json() {
  local json_checks="[]"
  for entry in "${RESULTS[@]}"; do
    IFS='|' read -r name key st msg details fix <<< "$entry"

    # Build details array
    local det_json="[]"
    if [[ -n "$details" ]]; then
      det_json=$(echo -e "$details" | jq -R 'select(length > 0)' | jq -s '.')
    fi

    # Build fix value
    local fix_json="null"
    if [[ -n "$fix" ]]; then
      fix_json=$(echo -e "$fix" | sed '/^$/d' | tr '\n' ';' | sed 's/;$//' | jq -R '.')
    fi

    # Append check object using jq
    json_checks=$(jq --arg name "$name" --arg key "$key" --arg st "$st" \
      --arg msg "$msg" --argjson details "$det_json" --argjson fix "$fix_json" \
      '. + [{name: $name, key: $key, status: $st, message: $msg, details: $details, fix: $fix}]' \
      <<< "$json_checks")
  done

  local exit_code=0
  (( FAIL_N > 0 )) && exit_code=1

  jq -n --argjson checks "$json_checks" \
    --argjson pass "$PASS_N" --argjson warn "$WARN_N" --argjson fail "$FAIL_N" \
    --argjson exitCode "$exit_code" \
    '{checks: $checks, summary: {pass: $pass, warn: $warn, fail: $fail}, exitCode: $exitCode}'
}

# ─── Main ──────────────────────────────────────────────────────────

# Handle special flags before running checks
if $COLLECT_LOGS; then
  do_collect_logs
  exit 0
fi

if $GITHUB_MODE; then
  do_github
  exit $?
fi

if $FIX_MODE; then
  do_fix
  exit $?
fi

ALL_CHECKS=(dependencies environment config services embed permissions disk steward workers delivery hooks logs)

if [[ -n "$CHECK_FILTER" ]]; then
  found=false
  for c in "${ALL_CHECKS[@]}"; do
    [[ "$c" == "$CHECK_FILTER" ]] && found=true
  done
  if ! $found; then
    echo "Unknown check: $CHECK_FILTER" >&2
    echo "Available: ${ALL_CHECKS[*]}" >&2
    exit 2
  fi
fi

run_checks() {
  for check in "${ALL_CHECKS[@]}"; do
    [[ -n "$CHECK_FILTER" && "$check" != "$CHECK_FILTER" ]] && continue
    if ! "check_${check}" 2>/dev/null; then
      # Only add ERR! if the check didn't add its own result
      local found=false
      for entry in "${RESULTS[@]}"; do
        [[ "$entry" == *"|${check}|"* ]] && found=true
      done
      $found || add_result "$check" "$check" "ERR!" "unexpected error" "" ""
    fi
  done
}

run_checks

if $JSON_MODE; then
  print_json
else
  print_human
fi

(( FAIL_N > 0 )) && exit 1 || exit 0
