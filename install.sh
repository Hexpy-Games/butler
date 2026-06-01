#!/usr/bin/env bash
# install.sh — Butler interactive installer
# Usage: ./install.sh [--non-interactive] [--auto-env] [--home PATH] [--data PATH] [--model openai|local|local/<id>] [--local-model-url URL] [--register-service|--no-register-service]
# Safe to run multiple times (idempotent)
set -euo pipefail

# ─── CLI flags ────────────────────────────────────────────────────────────────

AUTO_ENV="${BUTLER_AUTO_ENV:-true}"
NON_INTERACTIVE="${NON_INTERACTIVE:-false}"
INSTALL_HOME_ARG=""
INSTALL_DATA_ARG=""
INSTALL_LANG_ARG=""
INSTALL_GATEWAY_ARG=""
INSTALL_MODEL_ARG=""
INSTALL_LOCAL_MODEL_URL_ARG=""
PRINT_UPGRADE_REPORT=false
RUNTIME_REPAIR_ONLY=false
REGISTER_SERVICE_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --auto-env)
      AUTO_ENV=true
      shift
      ;;
    --no-auto-env)
      AUTO_ENV=false
      shift
      ;;
    --non-interactive)
      NON_INTERACTIVE=true
      shift
      ;;
    --home)
      INSTALL_HOME_ARG="${2:-}"
      [[ -n "$INSTALL_HOME_ARG" ]] || { echo "--home requires a path" >&2; exit 2; }
      shift 2
      ;;
    --home=*)
      INSTALL_HOME_ARG="${1#--home=}"
      shift
      ;;
    --data)
      INSTALL_DATA_ARG="${2:-}"
      [[ -n "$INSTALL_DATA_ARG" ]] || { echo "--data requires a path" >&2; exit 2; }
      shift 2
      ;;
    --data=*)
      INSTALL_DATA_ARG="${1#--data=}"
      shift
      ;;
    --language|--lang)
      INSTALL_LANG_ARG="${2:-}"
      [[ -n "$INSTALL_LANG_ARG" ]] || { echo "$1 requires a language" >&2; exit 2; }
      shift 2
      ;;
    --language=*|--lang=*)
      INSTALL_LANG_ARG="${1#*=}"
      shift
      ;;
    --gateway)
      INSTALL_GATEWAY_ARG="${2:-}"
      [[ -n "$INSTALL_GATEWAY_ARG" ]] || { echo "--gateway requires app" >&2; exit 2; }
      case "$(printf '%s' "$INSTALL_GATEWAY_ARG" | tr '[:upper:]' '[:lower:]')" in
        app|butler-app|butler_app) ;;
        *) echo "--gateway currently supports app" >&2; exit 2 ;;
      esac
      shift 2
      ;;
    --gateway=*)
      INSTALL_GATEWAY_ARG="${1#--gateway=}"
      case "$(printf '%s' "$INSTALL_GATEWAY_ARG" | tr '[:upper:]' '[:lower:]')" in
        app|butler-app|butler_app) ;;
        *) echo "--gateway currently supports app" >&2; exit 2 ;;
      esac
      shift
      ;;
    --model)
      INSTALL_MODEL_ARG="${2:-}"
      [[ -n "$INSTALL_MODEL_ARG" ]] || { echo "--model requires openai, local, or local/<model-id>" >&2; exit 2; }
      shift 2
      ;;
    --model=*)
      INSTALL_MODEL_ARG="${1#--model=}"
      shift
      ;;
    --local-model-url)
      INSTALL_LOCAL_MODEL_URL_ARG="${2:-}"
      [[ -n "$INSTALL_LOCAL_MODEL_URL_ARG" ]] || { echo "--local-model-url requires a URL" >&2; exit 2; }
      shift 2
      ;;
    --local-model-url=*)
      INSTALL_LOCAL_MODEL_URL_ARG="${1#--local-model-url=}"
      shift
      ;;
    --upgrade-report)
      PRINT_UPGRADE_REPORT=true
      shift
      ;;
    --runtime-repair)
      RUNTIME_REPAIR_ONLY=true
      shift
      ;;
    --register-service)
      REGISTER_SERVICE_ARG="yes"
      shift
      ;;
    --no-register-service)
      REGISTER_SERVICE_ARG="no"
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

# ─── Paths ────────────────────────────────────────────────────────────────────

INSTALL_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

expand_install_path() {
  local value="$1"
  case "$value" in
    "~") printf '%s\n' "$HOME" ;;
    "~/"*) printf '%s/%s\n' "$HOME" "${value#~/}" ;;
    *) printf '%s\n' "$value" ;;
  esac
}

resolve_install_home() {
  local requested="${INSTALL_HOME_ARG:-${BUTLER_HOME:-$HOME/butler}}"
  requested="$(expand_install_path "$requested")"

  if [[ -z "$INSTALL_HOME_ARG" ]]; then
    # Older installs exported BUTLER_HOME=~/.butler. That path is private state
    # now, never the source checkout. Prefer the running installer.
    if [[ "$requested" == "$HOME/.butler" || "$requested" == "$HOME/.butler/"* ]]; then
      requested="$INSTALL_SCRIPT_DIR"
    elif [[ ! -f "$requested/package.json" && -f "$INSTALL_SCRIPT_DIR/package.json" ]]; then
      requested="$INSTALL_SCRIPT_DIR"
    fi
  fi

  printf '%s\n' "$requested"
}

resolve_install_data() {
  local requested="${INSTALL_DATA_ARG:-${BUTLER_DATA:-$HOME/.butler}}"
  requested="$(expand_install_path "$requested")"

  if [[ -z "$INSTALL_DATA_ARG" ]]; then
    # Legacy installs used ~/.butler/data and some smoke runs can leave temp
    # values in the shell. Fresh interactive installs should land in ~/.butler.
    case "$requested" in
      */.butler/data|/tmp/*|/private/tmp/*|/var/folders/*/T/*)
        requested="$HOME/.butler"
        ;;
    esac
  fi

  printf '%s\n' "$requested"
}

BUTLER_HOME="$(resolve_install_home)"
BUTLER_DATA="$(resolve_install_data)"
BUTLER_HOME="$(expand_install_path "$BUTLER_HOME")"
BUTLER_DATA="$(expand_install_path "$BUTLER_DATA")"
CONFIG_TEMPLATE="$BUTLER_HOME/butler.config.template.json"
CONFIG_PATH="$BUTLER_DATA/butler.config.json"
BUTLER_INSTALLER_VERSION="${BUTLER_INSTALLER_VERSION:-0.1.0}"

persona_locale_from_language() {
  local value
  value="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  case "$value" in
    ko|ko-*|korean|한국어|한국말|한국*) printf 'ko\n' ;;
    *) printf 'en\n' ;;
  esac
}
DEFAULT_NATIVE_RUNTIME="codex-api"
DEFAULT_OPENAI_MODEL="gpt-5.5-codex"
BUTLER_RUNTIME_HELPER="$BUTLER_HOME/packages/butler-agent/scripts/lib/butler-runtime.sh"

OS_SERVICE_REGISTRATION_RESULT="not-evaluated"

export BUTLER_HOME BUTLER_DATA BUTLER_INSTALLER_VERSION DEFAULT_NATIVE_RUNTIME DEFAULT_OPENAI_MODEL

if [[ -f "$BUTLER_RUNTIME_HELPER" ]]; then
  # shellcheck source=/dev/null
  source "$BUTLER_RUNTIME_HELPER"
fi

if [[ "$PRINT_UPGRADE_REPORT" == true ]]; then
  bun_bin="${BUTLER_BUN:-}"
  if [[ -z "$bun_bin" || ! -x "$bun_bin" ]]; then
    bun_bin="$BUTLER_DATA/runtime/bun/current/bin/bun"
  fi
  if [[ ! -x "$bun_bin" ]]; then
    bun_bin="$(command -v bun || true)"
  fi
  if [[ -z "$bun_bin" ]]; then
    echo "Butler runtime unavailable. Run install.sh first or set BUTLER_BUN=/path/to/bun." >&2
    exit 1
  fi
  "$bun_bin" run "$BUTLER_HOME/packages/butler-agent/scripts/upgrade-report.ts"
  exit 0
fi

# ─── Colors — Butler theme (24-bit RGB, OpenClaw-style palette) ──────────────
#
# Brand mapping (OpenClaw coral → Butler navy, OpenClaw cyan → Butler gold):
#   ACCENT      = brand primary, used for headers/banners/stage titles
#   SUCCESS     = completion/checkmarks
#   WARN        = amber warnings
#   ERROR       = error/failure
#   INFO        = secondary text (descriptions, hints)
#   MUTED       = tertiary text (dimmed labels, borders)

if [[ -z "${NO_COLOR:-}" ]] && ([[ "${FORCE_COLOR:-}" == "1" ]] || [[ -t 1 ]]); then
  BOLD='\033[1m'
  ACCENT='\033[38;2;107;140;204m'      # slate blue        #6B8CCC
  ACCENT_BRIGHT='\033[38;2;138;164;214m' # light steel blue #8AA4D6
  INFO='\033[38;2;136;146;176m'        # text-secondary    #8892b0
  SUCCESS='\033[38;2;40;180;120m'      # muted green       #28B478
  WARN='\033[38;2;255;176;32m'         # amber             #FFB020
  ERROR='\033[38;2;212;85;85m'         # bright red         #D45555
  MUTED='\033[38;2;122;139;168m'       # text-muted        #7A8BA8
  GOLD='\033[38;2;180;155;80m'         # brass accent      #B49B50
  NC='\033[0m'
else
  BOLD='' ACCENT='' ACCENT_BRIGHT='' INFO='' SUCCESS='' WARN='' ERROR=''
  MUTED='' GOLD='' NC=''
fi

# ─── Temp file management ────────────────────────────────────────────────────

TMPFILES=()
cleanup_tmpfiles() {
  local f
  for f in "${TMPFILES[@]:-}"; do
    rm -rf "$f" 2>/dev/null || true
  done
}

mktempfile() {
  local f
  f="$(mktemp)"
  TMPFILES+=("$f")
  echo "$f"
}

# ─── Butler Taglines ────────────────────────────────────────────────────────

BUTLER_TAGLINES=(
  "At your service, as always."
  "A well-run house needs no raised voices."
  "Shall I prepare the usual, sir?"
  "One does not rush excellence."
  "The details attend to themselves when I attend to the details."
  "Everything in its proper place."
  "I took the liberty of handling that already."
  "Discretion is the better part of service."
  "Very good, sir."
  "Consider it done."
  "A butler is never late, nor early."
  "Precision is not pedantry — it is respect."
)

random_tagline() {
  echo "${BUTLER_TAGLINES[$((RANDOM % ${#BUTLER_TAGLINES[@]}))]}"
}

# ─── UI Primitives (OpenClaw-style, butler-branded) ─────────────────────────

GUM=""

# Global cleanup list
_cleanup_files=()
trap 'cleanup_tmpfiles; for _f in "${_cleanup_files[@]:-}"; do rm -rf "$_f" 2>/dev/null; done' EXIT

is_non_interactive_shell() {
  if [[ "$NON_INTERACTIVE" == true ]]; then return 0; fi
  if [[ "${NO_PROMPT:-}" == "1" ]]; then return 0; fi
  if [[ -t 0 ]] && ([[ -t 2 ]] || [[ -r /dev/tty && -w /dev/tty ]]); then
    return 1
  fi
  return 0
}

gum_is_tty() {
  if [[ -n "${NO_COLOR:-}" ]]; then return 1; fi
  if [[ "${TERM:-dumb}" == "dumb" ]]; then return 1; fi
  if [[ -t 2 || -t 1 ]]; then return 0; fi
  if [[ -r /dev/tty && -w /dev/tty ]]; then return 0; fi
  return 1
}

# ── ui_info / ui_warn / ui_success / ui_error ──

ui_info() {
  local msg="$*"
  if [[ -n "$GUM" ]]; then
    "$GUM" log --level info "$msg"
  else
    echo -e "${MUTED}·${NC} ${msg}"
  fi
}

ui_warn() {
  local msg="$*"
  if [[ -n "$GUM" ]]; then
    "$GUM" log --level warn "$msg"
  else
    echo -e "${WARN}!${NC} ${msg}"
  fi
}

ui_success() {
  local msg="$*"
  if [[ -n "$GUM" ]]; then
    local mark
    mark="$("$GUM" style --foreground "#28B478" --bold "✓")"
    echo "${mark} ${msg}"
  else
    echo -e "${SUCCESS}✓${NC} ${msg}"
  fi
}

ui_error() {
  local msg="$*"
  if [[ -n "$GUM" ]]; then
    "$GUM" log --level error "$msg"
  else
    echo -e "${ERROR}✗${NC} ${msg}"
  fi
}

# ── ui_section — bold section header ──

ui_section() {
  local title="$1"
  if [[ -n "$GUM" ]]; then
    "$GUM" style --bold --foreground "#6B8CCC" --padding "1 0" "$title"
  else
    echo ""
    echo -e "${ACCENT}${BOLD}${title}${NC}"
  fi
}

# ── ui_stage — phase counter [1/3] Title ──

INSTALL_STAGE_TOTAL=3
INSTALL_STAGE_CURRENT=0

ui_stage() {
  local title="$1"
  INSTALL_STAGE_CURRENT=$((INSTALL_STAGE_CURRENT + 1))
  echo ""
  if [[ -n "$GUM" ]]; then
    "$GUM" style --bold --foreground "#6B8CCC" --padding "1 0" \
      "[${INSTALL_STAGE_CURRENT}/${INSTALL_STAGE_TOTAL}] ${title}"
  else
    echo -e "\n${ACCENT}${BOLD}[${INSTALL_STAGE_CURRENT}/${INSTALL_STAGE_TOTAL}] ${title}${NC}\n"
  fi
}

# ── ui_kv — key-value pair with aligned columns ──

ui_kv() {
  local key="$1"
  local value="$2"
  if [[ -n "$GUM" ]]; then
    local key_part value_part
    key_part="$("$GUM" style --foreground "#7A8BA8" --width 20 "$key")"
    value_part="$("$GUM" style --bold "$value")"
    "$GUM" join --horizontal "$key_part" "$value_part"
  else
    printf "  ${MUTED}%-18s${NC} %s\n" "$key" "$value"
  fi
}

# ── ui_panel — rounded border info panel ──

ui_panel() {
  # Delegate to draw_panel for reliable rendering (gum style breaks on long text)
  local title="${1:-}"
  shift || true
  draw_panel "$title" "$@"
}

# ── draw_panel — manual box-drawing panel (no gum, no wrapping bugs) ──

C_BORDER="${MUTED}"

draw_panel() {
  local title="$1"
  shift
  local width=56
  local inner=$((width - 4))

  # Top border with title
  if [[ -n "$title" ]]; then
    local title_len=${#title}
    local remaining=$((width - title_len - 5))
    printf "  ${C_BORDER}╭─ %s %s╮${NC}\n" "$title" "$(printf '─%.0s' $(seq 1 $remaining))"
  else
    printf "  ${C_BORDER}╭%s╮${NC}\n" "$(printf '─%.0s' $(seq 1 $((width - 2))))"
  fi

  # Empty line
  printf "  ${C_BORDER}│${NC}%-$((width-2))s${C_BORDER}│${NC}\n" ""

  # Content lines — pre-wrapped
  for text in "$@"; do
    if [[ -z "$text" ]]; then
      printf "  ${C_BORDER}│${NC}%-$((width-2))s${C_BORDER}│${NC}\n" ""
    else
      echo "$text" | fold -s -w $inner | while IFS= read -r line; do
        printf "  ${C_BORDER}│${NC}  %-${inner}s${C_BORDER}│${NC}\n" "$line"
      done
    fi
  done

  # Empty line
  printf "  ${C_BORDER}│${NC}%-$((width-2))s${C_BORDER}│${NC}\n" ""

  # Bottom border
  printf "  ${C_BORDER}╰%s╯${NC}\n" "$(printf '─%.0s' $(seq 1 $((width - 2))))"
}

# ── ui_celebrate — bold completion message ──

ui_celebrate() {
  local msg="$1"
  if [[ -n "$GUM" ]]; then
    "$GUM" style --bold --foreground "#28B478" "$msg"
  else
    echo -e "${SUCCESS}${BOLD}${msg}${NC}"
  fi
}

# ── run_with_spinner — gum spin with fallback ──

run_with_spinner() {
  local title="$1"
  shift
  if [[ -n "$GUM" ]] && gum_is_tty; then
    local gum_err
    gum_err="$(mktempfile)"
    if "$GUM" spin --spinner dot --title "$title" -- "$@" 2>"$gum_err"; then
      return 0
    fi
    local gum_status=$?
    # If gum raw mode fails, fall back to plain
    if [[ -s "$gum_err" ]] && grep -Eiq 'setrawmode' "$gum_err"; then
      GUM=""
      ui_warn "Spinner unavailable in this terminal; continuing without"
      "$@"
      return $?
    fi
    if [[ -s "$gum_err" ]]; then cat "$gum_err" >&2; fi
    return "$gum_status"
  fi
  "$@"
}

# ── run_quiet_step — suppress success output, show failure with context ──

run_quiet_step() {
  local title="$1"
  shift
  local logfile
  logfile="$(mktempfile)"

  # NOTE: "$*" joins all remaining args with IFS into a single string for bash -c.
  # All callers must pass the command as a single pre-built string (not separate words).
  # This is intentional — gum spin requires a single shell command string.
  if [[ -n "$GUM" ]] && gum_is_tty; then
    if "$GUM" spin --spinner dot --title "$title" -- bash -c "$* > $logfile 2>&1"; then
      ui_success "$title"
      return 0
    fi
  else
    printf "  %s... " "$title"
    if bash -c "$*" > "$logfile" 2>&1; then
      echo "done"
      return 0
    fi
  fi

  # Failure: show what went wrong
  ui_error "${title}"
  if [[ -s "$logfile" ]]; then
    echo ""
    echo -e "  ${MUTED}Last 20 lines of output:${NC}"
    tail -n 20 "$logfile" | sed 's/^/    /'
    echo ""
  fi
  return 1
}

# ─── gum Bootstrap ────────────────────────────────────────────────────────────

bootstrap_gum() {
  # Skip if no TTY, non-interactive, or explicitly suppressed
  if [[ "${BUTLER_NO_GUM:-}" == "1" ]] || [[ ! -t 0 ]] || [[ "${NO_PROMPT:-}" == "1" ]] || [[ "$NON_INTERACTIVE" == true ]]; then
    return 1
  fi

  # Already installed system-wide?
  if command -v gum &>/dev/null; then
    GUM="gum"
    return 0
  fi

  # Auto-download to temp dir
  local gum_version="0.17.0"
  local os arch tmpdir gum_tar checksum_url
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$arch" in
    x86_64)        arch="x86_64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) return 1 ;;
  esac

  case "$os" in
    Darwin) os="Darwin" ;;
    Linux)  os="Linux" ;;
    *) return 1 ;;
  esac

  tmpdir="$(mktemp -d)"
  _cleanup_files+=("$tmpdir")
  local base_url="https://github.com/charmbracelet/gum/releases/download/v${gum_version}"
  gum_tar="gum_${gum_version}_${os}_${arch}.tar.gz"
  checksum_url="${base_url}/checksums.txt"

  if ! curl -fsSL "${base_url}/${gum_tar}" -o "${tmpdir}/${gum_tar}" 2>/dev/null; then
    return 1
  fi

  # SHA-256 checksum verification
  if curl -fsSL "$checksum_url" -o "${tmpdir}/checksums.txt" 2>/dev/null; then
    local expected actual
    expected=$(grep -F "$gum_tar" "${tmpdir}/checksums.txt" | grep -v '\.sbom\.' | awk '{print $1}')
    if command -v shasum &>/dev/null; then
      actual=$(shasum -a 256 "${tmpdir}/${gum_tar}" | awk '{print $1}')
    elif command -v sha256sum &>/dev/null; then
      actual=$(sha256sum "${tmpdir}/${gum_tar}" | awk '{print $1}')
    fi
    if [[ -n "${expected:-}" ]] && [[ -n "${actual:-}" ]] && [[ "$expected" != "$actual" ]]; then
      return 1
    fi
  fi

  tar -xzf "${tmpdir}/${gum_tar}" -C "$tmpdir" 2>/dev/null
  if [[ -x "${tmpdir}/gum" ]]; then
    GUM="${tmpdir}/gum"
  elif [[ -x "${tmpdir}/gum_${gum_version}_${os}_${arch}/gum" ]]; then
    GUM="${tmpdir}/gum_${gum_version}_${os}_${arch}/gum"
  else
    return 1
  fi

  return 0
}

# ─── Installer Banner ────────────────────────────────────────────────────────

print_installer_banner() {
  local tagline
  tagline="$(random_tagline)"

  if [[ -n "$GUM" ]]; then
    local title subtitle hint card
    title="$("$GUM" style --foreground "#6B8CCC" --bold "Butler Installer")"
    subtitle="$("$GUM" style --foreground "#8892b0" "$tagline")"
    hint="$("$GUM" style --foreground "#7A8BA8" "interactive setup")"
    card="$(printf '%s\n%s\n%s' "$title" "$subtitle" "$hint")"
    "$GUM" style --border rounded --border-foreground "#6B8CCC" --padding "1 2" "$card"
    echo ""
  else
    echo ""
    echo -e "  ${ACCENT}${BOLD}Butler Installer${NC}"
    echo -e "  ${INFO}${tagline}${NC}"
    echo -e "  ${MUTED}interactive setup${NC}"
    echo ""
  fi
}

# ─── Install Plan Panel ──────────────────────────────────────────────────────

show_install_plan() {
  local dep_status=""
  [[ -n "${BUTLER_BUN:-}" && -x "$BUTLER_BUN" ]] && dep_status+="runtime ✓  " || dep_status+="runtime ✗  "
  command -v git &>/dev/null   && dep_status+="git ✓" || dep_status+="git ✗"

  local os_label="${OS_TYPE} ${ARCH_TYPE}"

  if [[ -n "$GUM" ]]; then
    local line1 line2 line3 line4 line5
    line1=$(ui_kv "OS" "$os_label")
    line2=$(ui_kv "Butler Home" "$BUTLER_HOME")
    line3=$(ui_kv "Data Dir" "$BUTLER_DATA")
    line4=$(ui_kv "Dependencies" "$dep_status")
    line5=$(ui_kv "Services" "native supervisor")

    "$GUM" style \
      --border rounded \
      --border-foreground "#7A8BA8" \
      --padding "1 2" \
      --margin "1 2" \
      --bold "Install Plan" \
      "" \
      "$line1" \
      "$line2" \
      "$line3" \
      "$line4" \
      "$line5"
  else
    echo ""
    echo -e "  ${BOLD}Install Plan${NC}"
    echo ""
    ui_kv "OS" "$os_label"
    ui_kv "Butler Home" "$BUTLER_HOME"
    ui_kv "Data Dir" "$BUTLER_DATA"
    ui_kv "Dependencies" "$dep_status"
    ui_kv "Services" "native supervisor"
    echo ""
  fi
}

# ─── Footer Links Panel ──────────────────────────────────────────────────────

show_footer_links() {
  draw_panel "" \
    "Need help?" \
    "Docs:   README.md" \
    "Issues: project issue tracker"
}

# ─── Prompt Wrappers (gum with plain fallback) ───────────────────────────────

prompt_input() {
  local label="$1" default="${2:-}"
  if [[ -n "$GUM" ]]; then
    "$GUM" input --placeholder "$label" --placeholder.foreground "#7A8BA8" --value "$default"
  else
    local result
    if [[ -n "$default" ]]; then
      read -rp "  $label [$default]: " result
      echo "${result:-$default}"
    else
      read -rp "  $label: " result
      echo "$result"
    fi
  fi
}

prompt_write() {
  local placeholder="$1"
  if [[ -n "$GUM" ]]; then
    "$GUM" write --placeholder "$placeholder" --placeholder.foreground '240'
  else
    echo "  (Enter text, empty line to finish)" >&2
    local result="" line
    while IFS= read -r line; do
      [[ -z "$line" ]] && break
      result+="$line"$'\n'
    done
    echo "$result"
  fi
}

prompt_choose() {
  if [[ -n "$GUM" ]]; then
    "$GUM" choose "$@"
  else
    local i=1
    for item in "$@"; do
      echo "  $i) $item" >&2
      ((i++))
    done
    local choice
    read -rp "  Choice [1-$#]: " choice
    local idx=$((choice))
    if [[ $idx -ge 1 ]] && [[ $idx -le $# ]]; then
      echo "${@:$idx:1}"
    else
      echo "$1"
    fi
  fi
}

normalize_confirm_answer() {
  printf '%s' "${1:-}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]'
}

confirm_answer_is_yes() {
  case "$(normalize_confirm_answer "${1:-}")" in
    y|yes) return 0 ;;
    *) return 1 ;;
  esac
}

prompt_confirm() {
  local question="$1"
  if [[ -n "$GUM" ]]; then
    "$GUM" confirm \
      --affirmative "Yes" --negative "No" \
      "$question" && return 0 || return 1
  else
    local answer
    read -rp "  $question [y/N]: " answer
    confirm_answer_is_yes "$answer"
  fi
}

# ─── Timeline-Style Prompt UI ───────────────────────────────────────────────

tl_line() {
  echo -e "  ${MUTED}│${NC}"
}

tl_step() {
  local num="$1" title="$2"
  tl_line
  local prefix="Step"
  [[ "${INSTALL_LANG:-en}" == "ko" ]] && prefix="단계"
  echo -e "  ${ACCENT}${BOLD}●${NC} ${BOLD}${prefix} ${num} · ${title}${NC}"
}

tl_done() {
  local num="$1" title="$2" detail="${3:-}"
  local prefix="Step"
  [[ "${INSTALL_LANG:-en}" == "ko" ]] && prefix="단계"
  if [[ -n "$detail" ]]; then
    echo -e "  ${SUCCESS}✓${NC} ${MUTED}${prefix} ${num} · ${title} — ${detail}${NC}"
  else
    echo -e "  ${SUCCESS}✓${NC} ${MUTED}${prefix} ${num} · ${title}${NC}"
  fi
}

tl_text() {
  echo "$1" | fold -s -w 55 | while IFS= read -r line; do
    printf "  ${MUTED}│${NC}   ${INFO}%s${NC}\n" "$line"
  done
}

tl_muted() {
  echo "$1" | fold -s -w 55 | while IFS= read -r line; do
    printf "  ${MUTED}│${NC}   ${MUTED}%s${NC}\n" "$line"
  done
}

tl_success() {
  echo -e "  ${MUTED}│${NC}   ${SUCCESS}✓${NC} $*"
}

tl_warn() {
  echo -e "  ${MUTED}│${NC}   ${WARN}!${NC} $*"
}

tl_input() {
  local label="$1" default="${2:-}"
  if [[ -n "$GUM" ]]; then
    "$GUM" input --prompt "  │   ▸ " --prompt.foreground "#6B8CCC" --placeholder "$label" --placeholder.foreground "#7A8BA8" --value "$default" --width 45
  else
    local result
    if [[ -n "$default" ]]; then
      read -rp "  │   $label [$default]: " result
      echo "${result:-$default}"
    else
      read -rp "  │   $label: " result
      echo "$result"
    fi
  fi
}

tl_secret_input() {
  local label="$1" default="${2:-}"
  if [[ -n "$GUM" ]]; then
    "$GUM" input --prompt "  │   ▸ " --prompt.foreground "#6B8CCC" --placeholder "$label" --placeholder.foreground "#7A8BA8" --value "$default" --password --width 45
  else
    local result
    if [[ -n "$default" ]]; then
      read -rsp "  │   $label [already set, press Enter to keep]: " result
      echo "" >&2
      echo "${result:-$default}"
    else
      read -rsp "  │   $label: " result
      echo "" >&2
      echo "$result"
    fi
  fi
}

tl_choose_can_use_terminal_selector() {
  [[ "${BUTLER_TEST_FORCE_TL_CHOOSE_TTY:-}" == "1" ]] && return 0
  [[ -t 0 ]] && ([[ -t 2 ]] || [[ -r /dev/tty && -w /dev/tty ]])
}

tl_choose_terminal() {
  local selected=1 key seq i item idx
  while true; do
    i=1
    for item in "$@"; do
      printf '\r\033[K' >&2
      if [[ "$i" -eq "$selected" ]]; then
        echo -e "  ${MUTED}│${NC}   ${ACCENT}▸${NC} ${BOLD}${item}${NC}" >&2
      else
        echo -e "  ${MUTED}│${NC}     ${item}${NC}" >&2
      fi
      ((i++))
    done

    if ! IFS= read -rsn1 key; then
      echo "$1"
      return 0
    fi

    if [[ "$key" == $'\x1b' ]]; then
      seq=""
      IFS= read -rsn2 -t 1 seq || true
      case "$seq" in
        "[A"|OA|"[D"|OD) selected=$((selected > 1 ? selected - 1 : $#)) ;;
        "[B"|OB|"[C"|OC) selected=$((selected < $# ? selected + 1 : 1)) ;;
      esac
    elif [[ "$key" == "" ]]; then
      echo "${@:$selected:1}"
      return 0
    elif [[ "$key" =~ [1-9] ]]; then
      idx=$((key))
      if [[ "$idx" -ge 1 && "$idx" -le "$#" ]]; then
        echo "${@:$idx:1}"
        return 0
      fi
    fi

    printf '\033[%sA' "$#" >&2
  done
}

tl_choose_numbered() {
  local i=1
  for item in "$@"; do
    echo "  │   $i) $item" >&2
    ((i++))
  done
  local choice
  read -rp "  │   Choice [1-$#]: " choice
  local idx=$((choice))
  if [[ $idx -ge 1 ]] && [[ $idx -le $# ]]; then
    echo "${@:$idx:1}"
  else
    echo "$1"
  fi
}

tl_choose() {
  if tl_choose_can_use_terminal_selector; then
    tl_choose_terminal "$@"
  elif [[ -n "$GUM" ]]; then
    "$GUM" choose --header "" --cursor "      ▸ " --cursor.foreground "#6B8CCC" --height 10 "$@"
  else
    tl_choose_numbered "$@"
  fi
}

tl_write() {
  local placeholder="$1"
  if [[ -n "$GUM" ]]; then
    printf "\n" >&2
    local result
    result=$("$GUM" write --header "" --placeholder "$placeholder" --placeholder.foreground '240' --width 50 --height 5)
    printf "\n" >&2
    echo "$result"
  else
    echo "  │   (Enter text, empty line to finish)" >&2
    local result="" line
    while IFS= read -r line; do
      [[ -z "$line" ]] && break
      result+="$line"$'\n'
    done
    echo "$result"
  fi
}

tl_confirm() {
  local prompt="$1"
  shift
  if [[ -n "$GUM" ]]; then
    "$GUM" confirm \
      --affirmative "Yes" --negative "No" \
      --padding "0 0 0 6" \
      --selected.background "#6B8CCC" \
      --selected.foreground "#1a1a2e" \
      --unselected.background "#3a3f50" \
      --unselected.foreground "#7A8BA8" \
      --prompt.foreground "#DDE0E6" \
      "$prompt" "$@" && return 0 || return 1
  else
    local answer
    read -rp "  │   $prompt [y/N]: " answer
    confirm_answer_is_yes "$answer"
  fi
}

tl_examples() {
  if [[ -n "$GUM" ]]; then
    local styled
    styled=$("$GUM" style --foreground "#7A8BA8" --padding "0 0" "$@")
    while IFS= read -r line; do
      echo -e "  ${MUTED}│${NC}   $line"
    done <<< "$styled"
  else
    for line in "$@"; do
      echo -e "  ${MUTED}│${NC}   ${MUTED}${line}${NC}"
    done
  fi
}

# ─── Platform Detection ──────────────────────────────────────────────────────

detect_platform() {
  OS_TYPE="$(uname -s)"
  ARCH_TYPE="$(uname -m)"

  # Package manager
  if [[ "$OS_TYPE" == "Darwin" ]]; then
    PKG_INSTALL="brew install"
    PKG_MANAGER="brew"
  elif command -v apt-get &>/dev/null; then
    local sudo_prefix=""
    if [[ "$(id -u 2>/dev/null || echo 1)" != "0" ]]; then
      if command -v sudo &>/dev/null; then
        sudo_prefix="sudo "
      else
        PKG_INSTALL=""
        PKG_MANAGER="apt"
        return 0
      fi
    fi
    PKG_INSTALL="${sudo_prefix}apt-get update && ${sudo_prefix}apt-get install -y"
    PKG_MANAGER="apt"
  elif command -v dnf &>/dev/null; then
    local sudo_prefix=""
    if [[ "$(id -u 2>/dev/null || echo 1)" != "0" ]]; then
      if command -v sudo &>/dev/null; then
        sudo_prefix="sudo "
      else
        PKG_INSTALL=""
        PKG_MANAGER="dnf"
        return 0
      fi
    fi
    PKG_INSTALL="${sudo_prefix}dnf install -y"
    PKG_MANAGER="dnf"
  else
    PKG_INSTALL=""
    PKG_MANAGER="unknown"
  fi
}

# ─── Dependency Checks ───────────────────────────────────────────────────────

ensure_dependency() {
  local cmd="$1" install_cmd="$2" label="$3"
  if command -v "$cmd" &>/dev/null; then
    ui_success "$label: $("$cmd" --version 2>/dev/null | head -1)"
    return 0
  fi

  if [[ -z "$install_cmd" ]]; then
    ui_error "$label not found and no auto-install available"
    return 1
  fi

  if [[ "$NON_INTERACTIVE" == true ]] || prompt_confirm "Install $label?"; then
    run_quiet_step "Installing $label" "$install_cmd"
    if ! command -v "$cmd" &>/dev/null; then
      # Reload PATH for common user-level package-manager install locations.
      export PATH="$HOME/.local/bin:$PATH"
    fi
    if command -v "$cmd" &>/dev/null; then
      ui_success "$label installed: $("$cmd" --version 2>/dev/null | head -1)"
    else
      ui_error "Could not install $label"
      echo -e "  ${MUTED}Install it manually and re-run.${NC}"
      return 1
    fi
  else
    ui_error "$label is required"
    return 1
  fi
}

ensure_core_tool() {
  local cmd="$1" label="$2" package_name="${3:-$1}"
  if command -v "$cmd" &>/dev/null; then
    ui_success "$label: available"
    return 0
  fi

  local install_cmd=""
  if [[ -n "$PKG_INSTALL" ]]; then
    install_cmd="$PKG_INSTALL $package_name"
  fi
  ensure_dependency "$cmd" "$install_cmd" "$label"
}

bun_archive_slug() {
  local platform arch
  case "$OS_TYPE" in
    Darwin) platform="darwin" ;;
    Linux) platform="linux" ;;
    *)
      return 1
      ;;
  esac

  case "$ARCH_TYPE" in
    arm64|aarch64) arch="aarch64" ;;
    x86_64|amd64) arch="x64" ;;
    *)
      return 1
      ;;
  esac

  printf 'bun-%s-%s\n' "$platform" "$arch"
}

install_managed_bun() {
  local version root version_dir target_bin current_link slug archive_url tmp_dir archive_path
  version="$(butler_bun_pinned_version)"
  root="$(butler_bun_root)"
  version_dir="$root/$version"
  target_bin="$version_dir/bin/bun"
  current_link="$root/current"

  if [[ -x "$target_bin" ]]; then
    rm -rf "$current_link"
    ln -s "$version" "$current_link"
    export BUTLER_BUN="$target_bin"
    export PATH="$(dirname "$BUTLER_BUN"):$PATH"
    ui_success "Butler runtime: $("$BUTLER_BUN" --version 2>/dev/null | head -1) (managed)"
    return 0
  fi

  slug="$(bun_archive_slug)" || {
    ui_error "Unsupported Butler runtime platform: ${OS_TYPE}/${ARCH_TYPE}"
    return 1
  }

  ensure_core_tool curl "curl" || return 1
  ensure_core_tool unzip "unzip" || return 1

  archive_url="https://github.com/oven-sh/bun/releases/download/bun-v${version}/${slug}.zip"
  tmp_dir="$(mktemp -d)"
  TMPFILES+=("$tmp_dir")
  archive_path="$tmp_dir/${slug}.zip"

  if ! run_quiet_step "Preparing Butler runtime" "curl -fsSL '$archive_url' -o '$archive_path' && unzip -q '$archive_path' -d '$tmp_dir'"; then
    local existing
    existing="$(butler_bun_current_bin)"
    if [[ -x "$existing" ]]; then
      export BUTLER_BUN="$existing"
      export PATH="$(dirname "$BUTLER_BUN"):$PATH"
      ui_warn "Could not install pinned Butler runtime; using existing managed runtime: $("$BUTLER_BUN" --version 2>/dev/null | head -1)"
      return 0
    fi
    if command -v bun >/dev/null 2>&1; then
      export BUTLER_BUN="$(command -v bun)"
      export PATH="$(dirname "$BUTLER_BUN"):$PATH"
      ui_warn "Could not install managed runtime; using system Bun fallback: $("$BUTLER_BUN" --version 2>/dev/null | head -1)"
      return 0
    fi
    ui_error "Could not prepare Butler runtime"
    echo -e "  ${MUTED}Butler uses a private Bun runtime internally. Check network access or set BUTLER_BUN=/path/to/bun.${NC}"
    return 1
  fi

  mkdir -p "$version_dir/bin"
  cp "$tmp_dir/$slug/bun" "$target_bin"
  chmod +x "$target_bin"
  rm -rf "$current_link"
  ln -s "$version" "$current_link"
  export BUTLER_BUN="$target_bin"
  export PATH="$(dirname "$BUTLER_BUN"):$PATH"
  ui_success "Butler runtime ready: $("$BUTLER_BUN" --version 2>/dev/null | head -1)"
}

ensure_butler_runtime() {
  ui_section "Butler Runtime"
  echo ""

  if [[ -n "${BUTLER_BUN:-}" && -x "$BUTLER_BUN" ]]; then
    ui_success "Butler runtime override: $("$BUTLER_BUN" --version 2>/dev/null | head -1)"
    export PATH="$(dirname "$BUTLER_BUN"):$PATH"
    return 0
  fi

  install_managed_bun
}

check_dependencies() {
  ui_section "Dependency Check"
  echo ""

  # git
  if command -v git &>/dev/null; then
    ui_success "git: $(git --version | head -1)"
  else
    local git_install_cmd=""
    if [[ -n "$PKG_INSTALL" ]]; then
      git_install_cmd="$PKG_INSTALL git"
    fi
    ensure_dependency git "$git_install_cmd" "git" || exit 1
  fi

  ensure_butler_runtime || exit 1

}

# ─── Data Directory Setup ────────────────────────────────────────────────────

setup_directories() {
  ui_section "Directory Setup"
  echo ""

  mkdir -p "$BUTLER_DATA"/{memory/{hot,db,projects,conversations},cognition/profile,personas,config/subsession-activity,tasks,logs}
  ui_success "Data directory tree created"

  # Copy config template if no config exists
  if [[ ! -f "$CONFIG_PATH" ]]; then
    if [[ -f "$CONFIG_TEMPLATE" ]]; then
      cp "$CONFIG_TEMPLATE" "$CONFIG_PATH"
      ui_success "Config template copied"
    else
      ui_warn "butler.config.template.json not found — will create config from scratch"
    fi
  else
    ui_success "butler.config.json already exists"
  fi
}

read_env_value() {
  local env_path="$1" key="$2"
  [[ -f "$env_path" ]] || return 0
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, "", $0); print $0; exit }' "$env_path"
}

upsert_env_value() {
  local env_path="$1" key="$2" value="$3"
  touch "$env_path"
  if grep -q "^${key}=" "$env_path" 2>/dev/null; then
    sed -i.bak "s|^${key}=.*|${key}=${value}|" "$env_path"
    rm -f "${env_path}.bak"
  else
    echo "${key}=${value}" >> "$env_path"
  fi
}

resolve_runtime_choice() {
  echo "codex-api"
}

resolve_openai_auth_choice() {
  case "${1:-}" in
    codex-subscription|codex_subscription|openai-codex|codex-oauth|codex_oauth|oauth) echo "codex-subscription" ;;
    api-key|api_key) echo "api-key" ;;
    "") echo "codex-subscription" ;;
    *) echo "api-key" ;;
  esac
}

install_provider_choice_from_env() {
  local requested="${INSTALL_MODEL_ARG:-${BUTLER_MODEL_PROVIDER:-${BUTLER_INSTALL_MODEL_PROVIDER:-${BUTLER_MODEL_REF:-}}}}"
  if [[ -z "$requested" && -n "${INSTALL_LOCAL_MODEL_URL_ARG:-${BUTLER_LOCAL_MODEL_SERVER_URL:-}}" ]]; then
    requested="local"
  fi

  case "$(printf '%s' "$requested" | tr '[:upper:]' '[:lower:]')" in
    local|local/*|openai-compatible|openai_compatible|openai-compatible-local) echo "local" ;;
    codex|codex-subscription|codex_subscription|openai-codex|openai-codex-subscription) echo "codex-subscription" ;;
    anthropic|claude|anthropic/*) echo "anthropic" ;;
    google|gemini|google/*) echo "google" ;;
    xai|grok|xai/*) echo "xai" ;;
    qwen|qwen-cloud|qwen/*) echo "qwen" ;;
    kimi|moonshot|moonshot-kimi|kimi/*) echo "kimi" ;;
    openai|hosted|api|api-key|openai/*) echo "openai" ;;
    "")
      case "$(resolve_openai_auth_choice "${BUTLER_OPENAI_AUTH_METHOD:-}")" in
        codex-subscription) echo "codex-subscription" ;;
        *) echo "openai" ;;
      esac
      ;;
    *) echo "openai" ;;
  esac
}

install_provider_choice_is_explicit() {
  [[ -n "$INSTALL_MODEL_ARG" ||
     -n "${BUTLER_MODEL_PROVIDER:-}" ||
     -n "${BUTLER_INSTALL_MODEL_PROVIDER:-}" ||
     -n "${BUTLER_MODEL_REF:-}" ||
     -n "$INSTALL_LOCAL_MODEL_URL_ARG" ||
     -n "${BUTLER_LOCAL_MODEL_SERVER_URL:-}" ||
     -n "${BUTLER_OPENAI_AUTH_METHOD:-}" ]]
}

install_provider_choice_from_label() {
  case "$1" in
    "Open AI (API Key)"|"Open AI (API 키)") echo "openai" ;;
    "Anthropic") echo "anthropic" ;;
    "Google Gemini") echo "google" ;;
    "xAI / Grok") echo "xai" ;;
    "Qwen Cloud") echo "qwen" ;;
    "Moonshot / Kimi") echo "kimi" ;;
    "Open AI (Codex subscription)"|"Open AI (Codex 구독)") echo "codex-subscription" ;;
    "Local OpenAI-compatible model"|"로컬 OpenAI 호환 모델") echo "local" ;;
    *) echo "openai" ;;
  esac
}

select_install_provider_choice() {
  if [[ "${INSTALL_LANG:-en}" == "ko" ]]; then
    {
      tl_text "Butler가 사용할 모델 프로바이더를 선택해 주세요."
      tl_muted "로컬 모델은 마지막 항목입니다."
    } >&2
    install_provider_choice_from_label "$(
      tl_choose \
        "Open AI (API 키)" \
        "Open AI (Codex 구독)" \
        "Anthropic" \
        "Google Gemini" \
        "xAI / Grok" \
        "Qwen Cloud" \
        "Moonshot / Kimi" \
        "로컬 OpenAI 호환 모델"
    )"
  else
    {
      tl_text "Choose the model provider Butler should use."
      tl_muted "Local model is the last option."
    } >&2
    install_provider_choice_from_label "$(
      tl_choose \
        "Open AI (API Key)" \
        "Open AI (Codex subscription)" \
        "Anthropic" \
        "Google Gemini" \
        "xAI / Grok" \
        "Qwen Cloud" \
        "Moonshot / Kimi" \
        "Local OpenAI-compatible model"
    )"
  fi
}

model_provider_choice_from_env() {
  local requested="${INSTALL_MODEL_ARG:-${BUTLER_MODEL_PROVIDER:-${BUTLER_INSTALL_MODEL_PROVIDER:-${BUTLER_MODEL_REF:-}}}}"
  if [[ -z "$requested" && -n "${INSTALL_LOCAL_MODEL_URL_ARG:-${BUTLER_LOCAL_MODEL_SERVER_URL:-}}" ]]; then
    requested="local"
  fi
  case "$(printf '%s' "$requested" | tr '[:upper:]' '[:lower:]')" in
    local|local/*|openai-compatible|openai_compatible|openai-compatible-local) echo "local" ;;
    openai|hosted|api|api-key|codex|codex-subscription|openai/*|"") echo "openai" ;;
    *) echo "openai" ;;
  esac
}

model_provider_choice_is_explicit() {
  [[ -n "$INSTALL_MODEL_ARG" ||
     -n "${BUTLER_MODEL_PROVIDER:-}" ||
     -n "${BUTLER_INSTALL_MODEL_PROVIDER:-}" ||
     -n "${BUTLER_MODEL_REF:-}" ||
     -n "$INSTALL_LOCAL_MODEL_URL_ARG" ||
     -n "${BUTLER_LOCAL_MODEL_SERVER_URL:-}" ]]
}

hosted_provider_default_metadata() {
  local provider_id="$1"
  MODEL_CATALOG_MODULE="$BUTLER_HOME/packages/butler-agent/src/integrations/providers/model-catalog.ts" \
  PROVIDER_ID="$provider_id" \
  "$BUTLER_BUN" -e "
    import { pathToFileURL } from 'url';
    const { listModelMetadata } = await import(pathToFileURL(process.env.MODEL_CATALOG_MODULE).href);
    const providerId = process.env.PROVIDER_ID;
    const models = listModelMetadata().filter((model) => model.provider_id === providerId && model.runtime_supported);
    const model = models.find((item) => item.status === 'latest') ?? models.find((item) => item.status === 'recommended') ?? models[0];
    if (!model) process.exit(1);
    console.log([model.model_ref, model.model_id, model.display_name, model.provider_label].join('\\t'));
  "
}

hosted_provider_env_api_key() {
  local provider_id="$1"
  case "$provider_id" in
    openai) printf '%s\n' "${BUTLER_OPENAI_API_KEY:-${OPENAI_API_KEY:-}}" ;;
    anthropic) printf '%s\n' "${BUTLER_ANTHROPIC_API_KEY:-${ANTHROPIC_API_KEY:-}}" ;;
    google) printf '%s\n' "${BUTLER_GOOGLE_API_KEY:-${GOOGLE_API_KEY:-${GEMINI_API_KEY:-}}}" ;;
    xai) printf '%s\n' "${BUTLER_XAI_API_KEY:-${XAI_API_KEY:-}}" ;;
    qwen) printf '%s\n' "${BUTLER_QWEN_API_KEY:-${QWEN_API_KEY:-}}" ;;
    kimi) printf '%s\n' "${BUTLER_KIMI_API_KEY:-${KIMI_API_KEY:-${MOONSHOT_API_KEY:-}}}" ;;
    *) printf '\n' ;;
  esac
}

set_default_model_ref() {
  local model_ref="$1"
  local model_id="${2:-${model_ref#*/}}"
  CFG_PATH="$CONFIG_PATH" MODEL_REF="$model_ref" MODEL_ID="$model_id" "$BUTLER_BUN" -e "
    import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
    import { dirname } from 'path';
    const path = process.env.CFG_PATH;
    const modelRef = process.env.MODEL_REF;
    const modelId = process.env.MODEL_ID;
    const cfg = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
    cfg.system = cfg.system && typeof cfg.system === 'object' ? cfg.system : {};
    cfg.system.runtime = 'codex-api';
    cfg.system.defaultModel = modelRef;
    cfg.system.butlerModel = modelRef;
    if (modelRef?.startsWith('openai/')) cfg.system.openaiModel = modelId;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cfg, null, 2) + '\\n');
  "
}

register_hosted_api_key_provider() {
  local provider_id="$1"
  local model_ref model_id display_name provider_label api_key registered_ref
  IFS=$'\t' read -r model_ref model_id display_name provider_label < <(hosted_provider_default_metadata "$provider_id")
  api_key="$(hosted_provider_env_api_key "$provider_id")"

  if [[ -z "$api_key" ]] && ! is_non_interactive_shell; then
    tl_text "$provider_label API key를 입력해 주세요."
    tl_muted "키는 Butler private data의 credential store에 저장되며 화면에 다시 출력하지 않습니다."
    api_key="$(tl_secret_input "$provider_label API key" "")"
  fi

  if [[ -z "$api_key" ]]; then
    ui_error "$provider_label API key is required for the selected provider"
    return 1
  fi

  registered_ref="$(
    REGISTERED_MODELS_MODULE="$BUTLER_HOME/packages/butler-agent/src/integrations/providers/registered-models.ts" \
    PROVIDER_ID="$provider_id" \
    MODEL_ID="$model_id" \
    DISPLAY_NAME="$display_name" \
    API_KEY="$api_key" \
    CREDENTIAL_LABEL="$provider_label API key" \
    BUTLER_DATA="$BUTLER_DATA" \
    "$BUTLER_BUN" -e "
      import { pathToFileURL } from 'url';
      const { registerHostedModelConfig } = await import(pathToFileURL(process.env.REGISTERED_MODELS_MODULE).href);
      const model = registerHostedModelConfig({
        providerId: process.env.PROVIDER_ID,
        modelId: process.env.MODEL_ID,
        displayName: process.env.DISPLAY_NAME,
        authType: 'api_key',
        apiKey: process.env.API_KEY,
        credentialLabel: process.env.CREDENTIAL_LABEL,
      }, process.env.BUTLER_DATA);
      console.log(model.model_ref);
    "
  )"
  set_default_model_ref "$registered_ref" "$model_id"
  ui_success "$provider_label provider ready: $registered_ref"
}

local_model_id_from_env() {
  local value="${BUTLER_LOCAL_MODEL_ID:-}"
  if [[ -z "$value" && "${INSTALL_MODEL_ARG:-}" == local/* ]]; then
    value="${INSTALL_MODEL_ARG#local/}"
  fi
  if [[ -z "$value" && "${BUTLER_MODEL_REF:-}" == local/* ]]; then
    value="${BUTLER_MODEL_REF#local/}"
  fi
  printf '%s\n' "$value"
}

normalize_local_model_platform() {
  case "$(printf '%s' "${1:-custom}" | tr '[:upper:]' '[:lower:]' | tr '-' '_')" in
    llama_cpp|llamacpp|llama) echo "llama_cpp" ;;
    ollama) echo "ollama" ;;
    lm_studio|lmstudio) echo "lm_studio" ;;
    *) echo "custom" ;;
  esac
}

normalize_positive_integer_or_default() {
  local value default
  value="$(printf '%s' "${1:-}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  default="$(printf '%s' "${2:-32768}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  [[ "$default" =~ ^[0-9]+$ ]] || default="32768"
  if [[ "$value" =~ ^[0-9]+$ ]] && (( value > 0 )); then
    printf '%s\n' "$value"
  else
    printf '%s\n' "$default"
  fi
}

discover_local_models_json() {
  local server_url="$1" platform="$2"
  LOCAL_MODELS_MODULE="$BUTLER_HOME/packages/butler-agent/src/integrations/providers/local-models.ts" \
  LOCAL_MODEL_SERVER_URL="$server_url" \
  LOCAL_MODEL_PLATFORM="$platform" \
  "$BUTLER_BUN" -e "
    import { pathToFileURL } from 'url';
    const modulePath = process.env.LOCAL_MODELS_MODULE;
    const { discoverLocalModels } = await import(pathToFileURL(modulePath).href);
    const result = await discoverLocalModels({
      serverUrl: process.env.LOCAL_MODEL_SERVER_URL,
      platform: process.env.LOCAL_MODEL_PLATFORM || 'custom',
      apiType: 'openai_compatible',
    });
    console.log(JSON.stringify(result));
  " 2>/dev/null || true
}

local_model_ids_from_discovery() {
  local discovery_path="$1"
  DISCOVERY_PATH="$discovery_path" "$BUTLER_BUN" -e "
    const text = await Bun.file(process.env.DISCOVERY_PATH).text().catch(() => '');
    if (!text.trim()) process.exit(0);
    const result = JSON.parse(text);
    for (const model of result.models ?? []) {
      if (model?.model_id) console.log(model.model_id);
    }
  " 2>/dev/null || true
}

local_model_context_from_discovery() {
  local discovery_path="$1" model_id="$2"
  DISCOVERY_PATH="$discovery_path" LOCAL_MODEL_ID="$model_id" "$BUTLER_BUN" -e "
    const text = await Bun.file(process.env.DISCOVERY_PATH).text().catch(() => '');
    if (!text.trim()) process.exit(0);
    const result = JSON.parse(text);
    const models = Array.isArray(result.models) ? result.models : [];
    const model = models.find((candidate) => candidate.model_id === process.env.LOCAL_MODEL_ID);
    if (Number.isFinite(model?.context_window_tokens)) console.log(model.context_window_tokens);
  " 2>/dev/null || true
}

local_model_discovery_action_from_label() {
  case "$1" in
    "Try another server URL"|"다른 서버 URL로 다시 시도") echo "retry" ;;
    "Enter model ID manually"|"모델 ID 직접 입력") echo "manual" ;;
    *) echo "cancel" ;;
  esac
}

select_local_model_discovery_action() {
  if [[ "${INSTALL_LANG:-en}" == "ko" ]]; then
    {
      tl_text "로컬 모델 서버에서 모델 목록을 가져오지 못했습니다."
      tl_muted "서버가 꺼져 있거나 주소가 다를 수 있습니다."
    } >&2
    local_model_discovery_action_from_label "$(
      tl_choose \
        "다른 서버 URL로 다시 시도" \
        "모델 ID 직접 입력" \
        "로컬 모델 설정 취소"
    )"
  else
    {
      tl_text "Could not discover models from the local model server."
      tl_muted "The server may be off, or the address may be different."
    } >&2
    local_model_discovery_action_from_label "$(
      tl_choose \
        "Try another server URL" \
        "Enter model ID manually" \
        "Cancel local setup"
    )"
  fi
}

configure_local_model() {
  local server_url="${INSTALL_LOCAL_MODEL_URL_ARG:-${BUTLER_LOCAL_MODEL_SERVER_URL:-}}"
  local platform="${BUTLER_LOCAL_MODEL_PLATFORM:-}"
  local model_id
  model_id="$(local_model_id_from_env)"

  local discovery_json discovery_path discovery_platform auto_discovered_model
  discovery_path="$(mktempfile)"
  auto_discovered_model=false

  local discovered_ids=()
  while true; do
    if [[ -z "$server_url" ]]; then
      if is_non_interactive_shell; then
        ui_error "$([[ "${INSTALL_LANG:-en}" == "ko" ]] && echo "로컬 모델 서버 URL이 필요합니다. BUTLER_LOCAL_MODEL_SERVER_URL 또는 --local-model-url 을 설정하세요." || echo "Local model server URL is required. Set BUTLER_LOCAL_MODEL_SERVER_URL or --local-model-url.")"
        return 1
      fi
      if [[ "${INSTALL_LANG:-en}" == "ko" ]]; then
        tl_text "OpenAI 호환 로컬 모델 서버 URL을 입력해 주세요."
        tl_muted "예: llama.cpp server는 http://127.0.0.1:8080, Ollama는 http://127.0.0.1:11434"
      else
        tl_text "Enter the local OpenAI-compatible model server URL."
        tl_muted "Examples: llama.cpp server http://127.0.0.1:8080, Ollama http://127.0.0.1:11434"
      fi
      server_url="$(tl_input "Local model server URL" "http://127.0.0.1:8080")"
    fi

    discovery_platform="$(normalize_local_model_platform "${platform:-custom}")"
    : > "$discovery_path"
    discovery_json="$(discover_local_models_json "$server_url" "$discovery_platform")"
    if [[ -n "$discovery_json" ]]; then
      printf '%s\n' "$discovery_json" > "$discovery_path"
    fi

    discovered_ids=()
    while IFS= read -r discovered_id; do
      [[ -n "$discovered_id" ]] && discovered_ids+=("$discovered_id")
    done < <(local_model_ids_from_discovery "$discovery_path")

    if [[ -z "$model_id" && "${#discovered_ids[@]}" -gt 0 ]]; then
      model_id="${discovered_ids[0]}"
      platform="$discovery_platform"
      auto_discovered_model=true
      tl_success "$([[ "${INSTALL_LANG:-en}" == "ko" ]] && echo "로컬 모델 자동 감지: $model_id" || echo "Local model auto-detected: $model_id")"
    fi

    if [[ -n "$model_id" || "${#discovered_ids[@]}" -gt 0 ]]; then
      break
    fi

    if is_non_interactive_shell; then
      break
    fi

    case "$(select_local_model_discovery_action)" in
      retry)
        server_url="$(tl_input "Local model server URL" "$server_url")"
        ;;
      manual)
        break
        ;;
      *)
        ui_error "$([[ "${INSTALL_LANG:-en}" == "ko" ]] && echo "로컬 모델 설정을 취소했습니다." || echo "Local model setup cancelled.")"
        return 1
        ;;
    esac
  done

  if [[ -z "$platform" && -z "$model_id" ]] && ! is_non_interactive_shell; then
    local selected_platform
    selected_platform="$(tl_choose "llama.cpp" "Ollama" "LM Studio" "Custom")"
    case "$selected_platform" in
      "llama.cpp") platform="llama_cpp" ;;
      "Ollama") platform="ollama" ;;
      "LM Studio") platform="lm_studio" ;;
      *) platform="custom" ;;
    esac
  fi
  platform="$(normalize_local_model_platform "$platform")"

  if [[ -z "$model_id" ]]; then
    model_id="${discovered_ids[0]:-}"
  fi

  if [[ -z "$model_id" ]] && ! is_non_interactive_shell; then
    if [[ "${INSTALL_LANG:-en}" == "ko" ]]; then
      tl_text "자동으로 모델 ID를 찾지 못했습니다. OpenAI 호환 /v1/models 응답의 id 값을 입력해 주세요."
      tl_muted "예: gemma-4-31B-it"
    else
      tl_text "Could not discover a model id automatically. Enter the id value from the OpenAI-compatible /v1/models response."
      tl_muted "Example: gemma-4-31B-it"
    fi
    model_id="$(tl_input "Local model id" "")"
  fi
  if [[ -z "$model_id" ]]; then
    ui_error "$([[ "${INSTALL_LANG:-en}" == "ko" ]] && echo "로컬 모델 ID가 필요합니다. BUTLER_LOCAL_MODEL_ID 또는 --model local/<id> 를 설정하세요." || echo "Local model id is required. Set BUTLER_LOCAL_MODEL_ID or --model local/<id>.")"
    return 1
  fi

  local discovered_context context_tokens max_output_tokens
  discovered_context="$(local_model_context_from_discovery "$discovery_path" "$model_id")"
  context_tokens="${BUTLER_LOCAL_CONTEXT_WINDOW_TOKENS:-${BUTLER_LOCAL_MODEL_CONTEXT_TOKENS:-${discovered_context:-32768}}}"
  context_tokens="$(normalize_positive_integer_or_default "$context_tokens" "32768")"
  if [[ "$auto_discovered_model" != true ]] && ! is_non_interactive_shell; then
    context_tokens="$(tl_input "Context window tokens" "$context_tokens")"
    context_tokens="$(normalize_positive_integer_or_default "$context_tokens" "32768")"
  fi
  max_output_tokens="${BUTLER_LOCAL_MAX_OUTPUT_TOKENS:-}"

  local registered_json model_ref
  registered_json="$(
    LOCAL_MODELS_MODULE="$BUTLER_HOME/packages/butler-agent/src/integrations/providers/local-models.ts" \
    CFG_PATH="$CONFIG_PATH" \
    BUTLER_DATA="$BUTLER_DATA" \
    LOCAL_MODEL_SERVER_URL="$server_url" \
    LOCAL_MODEL_PLATFORM="$platform" \
    LOCAL_MODEL_ID="$model_id" \
    LOCAL_CONTEXT_WINDOW_TOKENS="$context_tokens" \
    LOCAL_MAX_OUTPUT_TOKENS="$max_output_tokens" \
    DEFAULT_OPENAI_MODEL="$DEFAULT_OPENAI_MODEL" \
    "$BUTLER_BUN" -e "
      import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
      import { dirname } from 'path';
      import { pathToFileURL } from 'url';
      const { upsertLocalModelConfig } = await import(pathToFileURL(process.env.LOCAL_MODELS_MODULE).href);
      const contextWindowTokens = Number(process.env.LOCAL_CONTEXT_WINDOW_TOKENS);
      if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) {
        throw new Error('Local context window tokens must be a positive number.');
      }
      const maxOutput = Number(process.env.LOCAL_MAX_OUTPUT_TOKENS);
      const model = upsertLocalModelConfig({
        serverUrl: process.env.LOCAL_MODEL_SERVER_URL,
        apiType: 'openai_compatible',
        platform: process.env.LOCAL_MODEL_PLATFORM || 'custom',
        modelId: process.env.LOCAL_MODEL_ID,
        contextWindowTokens,
        maxOutputTokens: Number.isFinite(maxOutput) && maxOutput > 0 ? maxOutput : undefined,
        source: 'manual',
      }, process.env.BUTLER_DATA);
      const path = process.env.CFG_PATH;
      let cfg = {};
      if (existsSync(path)) {
        try { cfg = JSON.parse(readFileSync(path, 'utf8')); } catch { cfg = {}; }
      }
      cfg.system = cfg.system && typeof cfg.system === 'object' ? cfg.system : {};
      cfg.system.runtime = 'codex-api';
      cfg.system.defaultModel = model.model_ref;
      cfg.system.butlerModel = model.model_ref;
      cfg.system.openaiModel = cfg.system.openaiModel || process.env.DEFAULT_OPENAI_MODEL;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(cfg, null, 2) + '\\n');
      console.log(JSON.stringify({ model_ref: model.model_ref, display_name: model.display_name }));
    "
  )"
  model_ref="$(REGISTERED_JSON="$registered_json" "$BUTLER_BUN" -e "const data = JSON.parse(process.env.REGISTERED_JSON); console.log(data.model_ref);")"
  ui_success "$([[ "${INSTALL_LANG:-en}" == "ko" ]] && echo "로컬 모델 등록 완료: $model_ref" || echo "Local model registered: $model_ref")"
}

codex_oauth_client_id() {
  printf '%s\n' "${BUTLER_CODEX_OAUTH_CLIENT_ID:-${BUTLER_OPENAI_OAUTH_CLIENT_ID:-app_EMoamEEZ73f0CkXaXp7hrann}}"
}

codex_subscription_login() {
  local client_id="${1:-$(codex_oauth_client_id)}"
  BUTLER_CODEX_OAUTH_CLIENT_ID="$client_id" "$BUTLER_BUN" run "$BUTLER_HOME/packages/butler-agent/scripts/openai-oauth-login.ts"
}

codex_subscription_profile_exists() {
  [[ -s "${BUTLER_CODEX_AUTH_PROFILE:-${BUTLER_OPENAI_AUTH_PROFILE:-$BUTLER_DATA/auth/openai-codex.json}}" ]]
}

require_source_file() {
  local path="$1" label="$2"
  if [[ ! -f "$path" ]]; then
    ui_error "Required source file missing: $label"
    echo "  Expected: $path" >&2
    echo "  Butler Home: $BUTLER_HOME" >&2
    return 1
  fi
}

write_default_eol() {
  local output_path="$1" butler_name="$2"
  local template_path="$BUTLER_HOME/packages/butler-agent/resources/templates/eol.template.md"
  require_source_file "$template_path" "packages/butler-agent/resources/templates/eol.template.md" || return 1

  local escaped_name
  escaped_name=$(printf '%s\n' "$butler_name" | sed 's/[&/\]/\\&/g')
  sed "s/{{butler_name}}/$escaped_name/g" "$template_path" > "$output_path"
}

generate_custom_eol() {
  local input="$1" butler_name="$2" output_path="$3"
  local generator_path="$BUTLER_HOME/packages/butler-agent/scripts/generate-eol.sh"
  local template_path="$BUTLER_HOME/packages/butler-agent/resources/templates/eol.template.md"
  require_source_file "$generator_path" "packages/butler-agent/scripts/generate-eol.sh" || return 1
  require_source_file "$template_path" "packages/butler-agent/resources/templates/eol.template.md" || return 1

  bash "$generator_path" "$input" "$butler_name" "$template_path" "$output_path"
}

telegram_detect_chat_id() {
  local bot_token="$1"
  local max_attempts="${2:-0}"
  local attempts=0
  local updates_response chat_id error_text

  curl -s -X POST "https://api.telegram.org/bot${bot_token}/deleteWebhook" \
    -d "drop_pending_updates=false" >/dev/null 2>&1 || true

  while true; do
    attempts=$((attempts + 1))
    updates_response=$(curl -s \
      --data-urlencode "timeout=10" \
      --data-urlencode "allowed_updates=[\"message\",\"edited_message\",\"channel_post\",\"my_chat_member\"]" \
      "https://api.telegram.org/bot${bot_token}/getUpdates" 2>/dev/null || true)
    if command -v jq &>/dev/null && [[ -n "$updates_response" ]]; then
      error_text=$(echo "$updates_response" | jq -r 'select(.ok == false) | .description // empty' 2>/dev/null || true)
      if [[ -n "$error_text" ]]; then
        echo "ERROR:${error_text}"
        return 1
      fi
      chat_id=$(echo "$updates_response" | jq -r '
        [
          .result[]?
          | (.message.chat.id // .edited_message.chat.id // .channel_post.chat.id // .my_chat_member.chat.id // empty)
        ]
        | map(tostring)
        | last // empty
      ' 2>/dev/null || true)
      if [[ -n "$chat_id" && "$chat_id" != "null" ]]; then
        echo "$chat_id"
        return 0
      fi
    fi
    if [[ "$max_attempts" -gt 0 && "$attempts" -ge "$max_attempts" ]]; then
      echo "ERROR:Timed out waiting for a Telegram DM."
      return 1
    fi
    sleep 2
  done
}

# ─── Minimal Runtime Setup / First-Chat Onboarding Marker ───────────────────

detect_user_timezone() {
  if [[ -f /etc/timezone ]]; then
    cat /etc/timezone
  elif command -v timedatectl &>/dev/null; then
    timedatectl show -p Timezone --value 2>/dev/null || echo "UTC"
  elif [[ "$OS_TYPE" == "Darwin" || "$(uname -s)" == "Darwin" ]]; then
    readlink /etc/localtime 2>/dev/null | sed 's|.*/zoneinfo/||' || echo "UTC"
  else
    echo "UTC"
  fi
}

install_language_label() {
  [[ "${INSTALL_LANG:-en}" == "ko" ]] && echo "한국어" || echo "English"
}

install_language_locale() {
  [[ "${INSTALL_LANG:-en}" == "ko" ]] && echo "ko" || echo "en"
}

write_minimal_runtime_config() {
  local user_tz language_label language_locale
  user_tz="$(detect_user_timezone)"
  language_label="$(install_language_label)"
  language_locale="$(install_language_locale)"

  CFG_PATH="$CONFIG_PATH" U_TZ="$user_tz" U_LANG="$language_locale" \
  B_NAME="Butler" OPENAI_MODEL="$DEFAULT_OPENAI_MODEL" \
  "$BUTLER_BUN" -e "
    import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
    import { dirname } from 'path';
    const path = process.env.CFG_PATH;
    let cfg = {};
    if (existsSync(path)) {
      try { cfg = JSON.parse(readFileSync(path, 'utf8')); } catch { cfg = {}; }
    }
    cfg.user = cfg.user && typeof cfg.user === 'object' ? cfg.user : {};
    if (!cfg.user.name || cfg.user.name === 'YourName') cfg.user.name = '';
    if (typeof cfg.user.bio !== 'string') cfg.user.bio = '';
    const installLanguage = process.env.U_LANG || 'en';
    cfg.user.timezone = cfg.user.timezone || process.env.U_TZ || 'UTC';
    cfg.user.language = installLanguage;
    cfg.user.responseLanguage = installLanguage;
    cfg.butler = cfg.butler && typeof cfg.butler === 'object' ? cfg.butler : {};
    cfg.butler.name = cfg.butler.name || process.env.B_NAME || 'Butler';
    cfg.system = cfg.system && typeof cfg.system === 'object' ? cfg.system : {};
    cfg.system.butlerHome = process.env.BUTLER_HOME;
    cfg.system.butlerData = process.env.BUTLER_DATA;
    cfg.system.runtime = 'codex-api';
    cfg.system.openaiModel = process.env.OPENAI_MODEL;
    cfg.system.defaultModel = 'openai/' + process.env.OPENAI_MODEL;
    cfg.system.activePersona = cfg.system.activePersona || 'butler';
    cfg.system.activePersonaLocale = installLanguage;
    cfg.system.installedAt = cfg.system.installedAt || new Date().toISOString();
    cfg.personalization = cfg.personalization && typeof cfg.personalization === 'object' ? cfg.personalization : {};
    cfg.personalization.profiling = cfg.personalization.profiling && typeof cfg.personalization.profiling === 'object'
      ? cfg.personalization.profiling
      : {};
    const profilingMode = cfg.personalization.profiling.mode === 'basic' || cfg.personalization.profiling.mode === 'deep'
      ? cfg.personalization.profiling.mode
      : 'off';
    cfg.personalization.profiling.enabled = profilingMode !== 'off';
    cfg.personalization.profiling.mode = profilingMode;
    cfg.personalization.profiling.extractorModel = cfg.personalization.profiling.extractorModel || 'default';
    cfg.personalization.profiling.consentVersion = cfg.personalization.profiling.consentVersion || '2026-05-16';
    cfg.personalization.profiling.consentedAt = profilingMode === 'off'
      ? null
      : typeof cfg.personalization.profiling.consentedAt === 'string'
        ? cfg.personalization.profiling.consentedAt
        : null;
    cfg.personalization.profiling.storage = 'cognition/profile/profile.sqlite';
    cfg.personalization.profiling.rawProfileBrowserVisible = false;
    cfg.webSearch = cfg.webSearch && typeof cfg.webSearch === 'object' ? cfg.webSearch : {};
    cfg.webSearch.provider = cfg.webSearch.provider || 'duckduckgo-html';
    cfg.webSearch.readerBackend = cfg.webSearch.readerBackend || 'lightweight';
    cfg.telegram = cfg.telegram && typeof cfg.telegram === 'object' ? cfg.telegram : {};
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
  "

  if [[ ! -f "$BUTLER_DATA/personas/active.md" && -f "$BUTLER_HOME/packages/butler-agent/scripts/generate-persona.sh" ]]; then
    bash "$BUTLER_HOME/packages/butler-agent/scripts/generate-persona.sh" \
      "butler" "$language_label" "polite" "" "Butler" \
      "$BUTLER_HOME/packages/butler-agent/resources/personas/templates" \
      "$BUTLER_DATA/personas/active.md" >/dev/null 2>&1 || true
  fi

  if [[ ! -f "$BUTLER_DATA/eol.md" ]]; then
    write_default_eol "$BUTLER_DATA/eol.md" "Butler"
  fi
}

initialize_first_chat_onboarding_state() {
  mkdir -p "$BUTLER_DATA/personalization"
  local onboarding_path="$BUTLER_DATA/personalization/onboarding.json"
  if [[ -f "$onboarding_path" ]]; then
    ui_success "$([[ "${INSTALL_LANG:-en}" == "ko" ]] && echo "첫 대화 온보딩 상태 유지" || echo "First-chat onboarding state preserved")"
    return 0
  fi

  ONBOARDING_PATH="$onboarding_path" "$BUTLER_BUN" -e "
    import { mkdirSync, writeFileSync } from 'fs';
    import { dirname } from 'path';
    const path = process.env.ONBOARDING_PATH;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify({
      schema: 'butler.first_chat_onboarding.v1',
      status: 'pending',
      gateway: 'any',
      fields: {},
      skipped_fields: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      completed_at: null
    }, null, 2) + '\n', { mode: 0o600 });
  "
  ui_success "$([[ "${INSTALL_LANG:-en}" == "ko" ]] && echo "첫 대화 온보딩 준비 완료" || echo "First-chat onboarding prepared")"
}

configure_api_provider() {
  ui_section "$([[ "${INSTALL_LANG:-en}" == "ko" ]] && echo "Model Setup" || echo "Model Setup")"
  echo ""

  write_minimal_runtime_config

  local provider_choice
  provider_choice="$(install_provider_choice_from_env)"
  if ! install_provider_choice_is_explicit && ! is_non_interactive_shell; then
    provider_choice="$(select_install_provider_choice)"
  fi

  if [[ "$provider_choice" == "local" ]]; then
    configure_local_model
    touch "$BUTLER_DATA/.env"
    chmod 600 "$BUTLER_DATA/.env"
    return 0
  fi

  if [[ "$provider_choice" != "codex-subscription" ]]; then
    register_hosted_api_key_provider "$provider_choice"
    touch "$BUTLER_DATA/.env"
    chmod 600 "$BUTLER_DATA/.env"
    return 0
  fi

  set_default_model_ref "openai/$DEFAULT_OPENAI_MODEL" "$DEFAULT_OPENAI_MODEL"
  ui_success "$([[ "${INSTALL_LANG:-en}" == "ko" ]] && echo "모델: $DEFAULT_OPENAI_MODEL" || echo "Model: $DEFAULT_OPENAI_MODEL")"

  local openai_auth_choice openai_api_key codex_oauth_client_id explicit_auth_method=false
  if [[ -n "${BUTLER_OPENAI_AUTH_METHOD:-}" ]]; then
    explicit_auth_method=true
    openai_auth_choice="$(resolve_openai_auth_choice "$BUTLER_OPENAI_AUTH_METHOD")"
  else
    openai_auth_choice="codex-subscription"
  fi
  openai_api_key="${BUTLER_OPENAI_API_KEY:-${OPENAI_API_KEY:-}}"
  codex_oauth_client_id="$(codex_oauth_client_id)"

  if [[ "$explicit_auth_method" == false ]]; then
    openai_auth_choice="codex-subscription"
  fi

  if [[ "$openai_auth_choice" == "codex-subscription" ]]; then
    if [[ -n "${BUTLER_CODEX_OAUTH_CLIENT_ID:-${BUTLER_OPENAI_OAUTH_CLIENT_ID:-}}" ]]; then
      upsert_env_value "$BUTLER_DATA/.env" "BUTLER_CODEX_OAUTH_CLIENT_ID" "$codex_oauth_client_id"
    fi
    if codex_subscription_profile_exists; then
      ui_success "$([[ "${INSTALL_LANG:-en}" == "ko" ]] && echo "Codex 구독 로그인 프로필 감지" || echo "Codex subscription auth profile detected")"
    elif is_non_interactive_shell; then
      ui_warn "$([[ "${INSTALL_LANG:-en}" == "ko" ]] && echo "Codex 구독 로그인 프로필이 없습니다. 첫 사용 전 로그인 또는 OPENAI_API_KEY가 필요합니다." || echo "Codex subscription auth profile missing. Login or OPENAI_API_KEY is needed before first real use.")"
    elif codex_subscription_login "$codex_oauth_client_id"; then
      ui_success "$([[ "${INSTALL_LANG:-en}" == "ko" ]] && echo "Codex 구독 로그인 완료" || echo "Codex subscription login completed")"
    else
      ui_warn "$([[ "${INSTALL_LANG:-en}" == "ko" ]] && echo "Codex 구독 로그인이 완료되지 않았습니다. API key를 입력하거나 나중에 다시 로그인할 수 있습니다." || echo "Codex subscription login did not complete. Enter an API key or configure login later.")"
      openai_api_key=$(tl_secret_input "OpenAI API key (optional)" "")
      if [[ -n "$openai_api_key" ]]; then
        upsert_env_value "$BUTLER_DATA/.env" "OPENAI_API_KEY" "$openai_api_key"
        ui_success "OPENAI_API_KEY configured"
      fi
    fi
  else
    if [[ -z "$openai_api_key" ]]; then
      if ! is_non_interactive_shell; then
        openai_api_key=$(tl_secret_input "OpenAI API key" "")
      fi
    fi
    if [[ -n "$openai_api_key" ]]; then
      upsert_env_value "$BUTLER_DATA/.env" "OPENAI_API_KEY" "$openai_api_key"
      ui_success "OPENAI_API_KEY configured"
    else
      ui_warn "$([[ "${INSTALL_LANG:-en}" == "ko" ]] && echo "OPENAI_API_KEY가 비어 있습니다. 첫 사용 전 인증 설정이 필요합니다." || echo "OPENAI_API_KEY is empty. Auth is needed before first real use.")"
    fi
  fi

  touch "$BUTLER_DATA/.env"
  chmod 600 "$BUTLER_DATA/.env"
}

gateway_choice_from_env() {
  case "$(printf '%s' "${INSTALL_GATEWAY_ARG:-${BUTLER_GATEWAY:-${BUTLER_INSTALL_GATEWAY:-}}}" | tr '[:upper:]' '[:lower:]')" in
    app|butler-app|butler_app|"") echo "app" ;;
    *) echo "app" ;;
  esac
}

gateway_choice_is_explicit() {
  [[ -n "${INSTALL_GATEWAY_ARG:-${BUTLER_GATEWAY:-${BUTLER_INSTALL_GATEWAY:-}}}" ]]
}

ensure_telegram_transport_config() {
  local telegram_config="$BUTLER_DATA/config/telegram-transport.json"
  if [[ ! -f "$telegram_config" ]]; then
    mkdir -p "$(dirname "$telegram_config")"
    cat > "$telegram_config" << EOF
{
  "topicRouting": {
    "enabled": true,
    "configSource": "$BUTLER_DATA/butler.config.json",
    "scripts": {
      "send": "$BUTLER_HOME/packages/butler-agent/scripts/subsession-send.sh",
      "start": "$BUTLER_HOME/packages/butler-agent/scripts/subsession-start.sh"
    }
  }
}
EOF
    ui_success "Telegram transport config created"
  else
    ui_success "Telegram transport config already exists"
  fi
}

configure_gateway() {
  ui_section "$([[ "${INSTALL_LANG:-en}" == "ko" ]] && echo "Gateway Setup" || echo "Gateway Setup")"
  echo ""

  BOT_TOKEN=""
  CHAT_ID=""
  ui_success "$([[ "${INSTALL_LANG:-en}" == "ko" ]] && echo "Butler 앱 게이트웨이 준비 완료" || echo "Butler App gateway ready")"
}

# ─── Steward / Transport Config ──────────────────────────────────────────────

setup_steward_and_transport() {
  ui_section "Config Files"
  echo ""

  # Steward prompt
  if [[ ! -f "$BUTLER_DATA/config/steward.md" ]]; then
    if [[ -f "$BUTLER_HOME/config/steward.md.template" ]]; then
      cp "$BUTLER_HOME/config/steward.md.template" "$BUTLER_DATA/config/steward.md"
      ui_success "steward.md created from template"
    elif [[ -f "$BUTLER_HOME/config/steward.md" ]]; then
      cp "$BUTLER_HOME/config/steward.md" "$BUTLER_DATA/config/steward.md"
      ui_success "steward.md migrated"
    fi
  else
    ui_success "steward.md already exists"
  fi

  # Steward settings
  if [[ ! -f "$BUTLER_DATA/config/steward-settings.json" ]]; then
    if [[ -f "$BUTLER_HOME/config/steward-settings.json" ]]; then
      cp "$BUTLER_HOME/config/steward-settings.json" "$BUTLER_DATA/config/steward-settings.json"
      ui_success "steward-settings.json copied"
    fi
  fi
}

# ─── Workspace Dependencies ──────────────────────────────────────────────────

install_workspace_deps() {
  ui_section "Installing Dependencies"
  echo ""

  # Root workspace
  if [[ -f "$BUTLER_HOME/package.json" ]]; then
    run_quiet_step "Root dependencies" \
      "cd '$BUTLER_HOME' && '$BUTLER_BUN' install --frozen-lockfile 2>/dev/null || '$BUTLER_BUN' install"
  fi

  # MCP server
  if [[ -f "$BUTLER_HOME/packages/butler-agent/src/interfaces/mcp-server/package.json" ]]; then
    run_quiet_step "MCP server deps" \
      "cd '$BUTLER_HOME/packages/butler-agent/src/interfaces/mcp-server' && '$BUTLER_BUN' install --frozen-lockfile 2>/dev/null || '$BUTLER_BUN' install"
  fi

  # Memory domain code is part of the root workspace.
}

cli_binary_platform() {
  local os arch
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    *) return 1 ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64) arch="x64" ;;
    *) return 1 ;;
  esac
  printf '%s-%s\n' "$os" "$arch"
}

install_cli_binary() {
  ui_section "CLI Binary"
  echo ""

  local launcher_path="$BUTLER_HOME/packages/butler-agent/src/interfaces/cli/launcher.ts"
  local output_path="$BUTLER_DATA/bin/butler"
  local prebuilt_path platform
  platform="$(cli_binary_platform || true)"
  local bun_q launcher_q output_q
  mkdir -p "$BUTLER_DATA/bin"
  if [[ -n "$platform" ]]; then
    prebuilt_path="$BUTLER_HOME/packages/butler-agent/resources/cli/$platform/butler"
    if [[ -f "$prebuilt_path" ]]; then
      cp "$prebuilt_path" "$output_path"
      chmod 755 "$output_path" 2>/dev/null || true
      ui_success "Butler CLI binary: $output_path"
      return 0
    fi
  fi

  require_source_file "$launcher_path" "packages/butler-agent/src/interfaces/cli/launcher.ts" || return 1
  bun_q="$(shell_quote "$BUTLER_BUN")"
  launcher_q="$(shell_quote "$launcher_path")"
  output_q="$(shell_quote "$output_path")"
  if run_quiet_step "Building Butler CLI binary fallback" "$bun_q build --compile --outfile $output_q $launcher_q"; then
    chmod 755 "$output_path" 2>/dev/null || true
    ui_success "Butler CLI binary: $output_path"
    return 0
  fi
  ui_error "Could not build Butler CLI binary"
  return 1
}

# ─── Shell Environment ───────────────────────────────────────────────────────

setup_shell_env() {
  ui_section "Shell Environment"
  echo ""

  local shell_rc="$HOME/.zshrc"
  [[ "${SHELL:-}" == */bash ]] && shell_rc="$HOME/.bashrc"
  local marker="# butler environment"

  local env_block
  env_block=$(cat << 'ENVBLOCKEOF'
# butler environment
export BUTLER_HOME="BUTLER_HOME_PLACEHOLDER"
export BUTLER_DATA="BUTLER_DATA_PLACEHOLDER"
export PATH="$BUTLER_DATA/bin:$PATH"
ENVBLOCKEOF
)
  env_block="${env_block//BUTLER_HOME_PLACEHOLDER/$BUTLER_HOME}"
  env_block="${env_block//BUTLER_DATA_PLACEHOLDER/$BUTLER_DATA}"

  if grep -q "$marker" "$shell_rc" 2>/dev/null; then
    local existing_home existing_data
    existing_home="$(grep -E '^export BUTLER_HOME=' "$shell_rc" 2>/dev/null | tail -1 || true)"
    existing_home="${existing_home#export BUTLER_HOME=}"
    existing_home="${existing_home%\"}"
    existing_home="${existing_home#\"}"
    existing_data="$(grep -E '^export BUTLER_DATA=' "$shell_rc" 2>/dev/null | tail -1 || true)"
    existing_data="${existing_data#export BUTLER_DATA=}"
    existing_data="${existing_data%\"}"
    existing_data="${existing_data#\"}"
    if [[ "$AUTO_ENV" == true || "$existing_home" != "$BUTLER_HOME" || "$existing_data" != "$BUTLER_DATA" ]]; then
      SHELL_RC="$shell_rc" ENV_BLOCK="$env_block" "$BUTLER_BUN" -e "
        import { readFileSync, writeFileSync } from 'fs';
        const path = process.env.SHELL_RC;
        const block = process.env.ENV_BLOCK;
        const text = readFileSync(path, 'utf8');
        const re = /# butler environment\nexport BUTLER_HOME=\"[^\"]*\"\nexport BUTLER_DATA=\"[^\"]*\"\nexport PATH=\"\\\$(?:BUTLER_HOME\/(?:bin|ops\/scripts|packages\/butler-agent\/scripts)|BUTLER_DATA\/bin):\\\$PATH\"/;
        const next = re.test(text)
          ? text.replace(re, block)
          : text.replace('# butler environment', block);
        writeFileSync(path, next);
      "
      ui_success "Environment updated in $(basename "$shell_rc")"
      export BUTLER_HOME BUTLER_DATA
    else
      ui_success "Environment already in $(basename "$shell_rc")"
    fi
  elif [[ "$AUTO_ENV" == true ]]; then
    echo "" >> "$shell_rc"
    echo "$env_block" >> "$shell_rc"
    ui_success "Environment added to $(basename "$shell_rc")"
    export BUTLER_HOME BUTLER_DATA
  else
    draw_panel "Shell Config" \
      "Add these to your $(basename "$shell_rc"):" \
      "" \
      "  export BUTLER_HOME=\"$BUTLER_HOME\"" \
      "  export BUTLER_DATA=\"$BUTLER_DATA\"" \
      "  export PATH=\"\$BUTLER_DATA/bin:\$PATH\"" \
      "" \
      "(or re-run with --auto-env)"
  fi
}

# ─── Native Service Setup ────────────────────────────────────────────────────

setup_services() {
  ui_section "Starting Butler Services"
  echo ""

  pushd "$BUTLER_HOME" > /dev/null
  "$BUTLER_HOME/packages/butler-agent/scripts/service-control.sh" start
  ui_success "Native services started"
  popd > /dev/null
}

os_service_registration_env_opt_in() {
  case "${BUTLER_REGISTER_SERVICE:-}" in
    1|true|TRUE|yes|YES|y|Y|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

os_service_registration_env_opt_out() {
  case "${BUTLER_REGISTER_SERVICE:-}" in
    0|false|FALSE|no|NO|n|N|off|OFF) return 0 ;;
    *) return 1 ;;
  esac
}

should_register_os_service_noninteractive() {
  case "$REGISTER_SERVICE_ARG" in
    yes) return 0 ;;
    no) return 1 ;;
  esac
  os_service_registration_env_opt_in && return 0
  os_service_registration_env_opt_out && return 1
  return 1
}

shell_quote() {
  printf "%q" "$1"
}

running_in_container() {
  [[ "${BUTLER_INSTALL_IN_DOCKER:-}" == "1" ]] && return 0
  [[ "${container:-}" != "" ]] && return 0
  [[ -f /.dockerenv || -f /run/.containerenv ]] && return 0
  if [[ -r /proc/1/cgroup ]] && grep -Eiq '(docker|containerd|kubepods|podman)' /proc/1/cgroup 2>/dev/null; then
    return 0
  fi
  return 1
}

linux_systemd_booted() {
  [[ -d /run/systemd/system ]] && return 0
  [[ -r /proc/1/comm ]] && [[ "$(cat /proc/1/comm 2>/dev/null)" == "systemd" ]]
}

macos_launchd_user_domain_available() {
  local uid
  uid="${UID:-$(id -u 2>/dev/null || true)}"
  [[ -n "$uid" ]] || return 1
  launchctl print "gui/$uid" >/dev/null 2>&1
}

os_service_registration_unavailable_reason() {
  if running_in_container; then
    if [[ "${INSTALL_LANG:-en}" == "ko" ]]; then
      echo "Docker/컨테이너 안에는 호스트 로그인 매니저가 없어 OS 서비스 자동 시작을 등록할 수 없습니다."
    else
      echo "Docker/container environments do not expose the host login manager required for OS service autostart."
    fi
    return 0
  fi

  if [[ "${OS_TYPE:-$(uname -s)}" == "Linux" ]]; then
    if ! command -v systemctl >/dev/null 2>&1; then
      echo "systemctl is not available, so a systemd user service cannot be registered."
      return 0
    fi
    if ! linux_systemd_booted; then
      echo "systemd does not appear to be booted, so a systemd user service cannot be registered."
      return 0
    fi
    if ! systemctl --user show-environment >/dev/null 2>&1; then
      echo "systemd --user is not available in this session. Try from a normal login session or enable linger, then run: butler service install --yes"
      return 0
    fi
  elif [[ "${OS_TYPE:-$(uname -s)}" == "Darwin" ]]; then
    if ! command -v launchctl >/dev/null 2>&1; then
      echo "launchctl is not available, so a launchd service cannot be registered."
      return 0
    fi
    if ! macos_launchd_user_domain_available; then
      echo "launchd user domain is not available in this session, so a LaunchAgent cannot be registered."
      return 0
    fi
  fi

  return 1
}

pause_for_os_service_failure() {
  if is_non_interactive_shell; then
    return 0
  fi
  local prompt
  if [[ "${INSTALL_LANG:-en}" == "ko" ]]; then
    prompt="  위 OS 서비스 등록 실패 로그를 확인한 뒤 Enter를 누르면 수동 서비스 시작으로 계속합니다: "
  else
    prompt="  Review the OS service registration failure above, then press Enter to continue with manual services: "
  fi
  if [[ -r /dev/tty ]]; then
    read -rp "$prompt" _ </dev/tty || true
  else
    read -rp "$prompt" _ || true
  fi
}

select_os_service_registration() {
  OS_SERVICE_REGISTRATION_RESULT="manual"

  case "$REGISTER_SERVICE_ARG" in
    yes)
      local reason
      if reason="$(os_service_registration_unavailable_reason)"; then
        tl_warn "$reason"
        OS_SERVICE_REGISTRATION_RESULT="unavailable"
        return 1
      fi
      return 0
      ;;
    no) return 1 ;;
  esac

  if is_non_interactive_shell; then
    if should_register_os_service_noninteractive; then
      local reason
      if reason="$(os_service_registration_unavailable_reason)"; then
        ui_warn "$reason"
        OS_SERVICE_REGISTRATION_RESULT="unavailable"
        return 1
      fi
      return 0
    fi
    return 1
  fi

  local unavailable_reason
  if unavailable_reason="$(os_service_registration_unavailable_reason)"; then
    tl_warn "$unavailable_reason"
    tl_muted "$([[ "${INSTALL_LANG:-en}" == "ko" ]] && echo "이 컨테이너에서는 지금 실행 중인 native service로 테스트하고, 호스트 자동 시작 등록은 호스트에서 butler service install --yes 로 다시 실행하세요." || echo "This container will use manual native services for the test run. Register host autostart later on the host with butler service install --yes.")"
    OS_SERVICE_REGISTRATION_RESULT="unavailable"
    return 1
  fi

  local selected_registration
  if [[ "${INSTALL_LANG:-en}" == "ko" ]]; then
    tl_text "로그인 후 Butler를 자동으로 시작하도록 OS 서비스를 등록할까요?"
    tl_muted "기본값은 Yes입니다. 나중에 butler service install --yes 로 다시 등록할 수 있습니다."
  else
    tl_text "Register Butler as an OS service so it starts automatically after login?"
    tl_muted "The default is Yes. You can register later with butler service install --yes."
  fi
  selected_registration="$(tl_choose "Yes" "No")"
  [[ "$selected_registration" == "Yes" ]]
}

setup_os_service_registration() {
  ui_section "OS Service Registration"
  echo ""

  local home_q bun_q stop_script_q registration_script_q
  home_q="$(shell_quote "$BUTLER_HOME")"
  bun_q="$(shell_quote "${BUTLER_BUN:-bun}")"
  stop_script_q="$(shell_quote "$BUTLER_HOME/packages/butler-agent/scripts/stop-butler.sh")"
  registration_script_q="$(shell_quote "$BUTLER_HOME/packages/butler-agent/scripts/os-service-registration.ts")"

  if run_quiet_step "Stopping existing manual services" "cd $home_q && $stop_script_q"; then
    ui_success "Existing manual services stopped"
  else
    if native_services_online; then
      ui_warn "Could not stop existing manual services; leaving them running instead of registering a duplicate service"
      OS_SERVICE_REGISTRATION_RESULT="blocked"
      return 0
    fi
    ui_warn "Could not fully stop existing manual services; continuing because no live native service state was detected"
  fi

  if run_quiet_step "Registering Butler OS service" "cd $home_q && $bun_q run $registration_script_q install --yes --quiet"; then
    ui_success "OS service registered and started"
    OS_SERVICE_REGISTRATION_RESULT="registered"
    return 0
  fi

  if native_services_online; then
    ui_warn "OS service registration reported failure, but Butler service state is already online; not starting a duplicate manual service"
    OS_SERVICE_REGISTRATION_RESULT="failed-active"
    return 0
  fi

  ui_warn "OS service registration failed; starting manual native services instead"
  echo -e "  ${MUTED}You can retry later with: butler service install --yes${NC}"
  pause_for_os_service_failure
  OS_SERVICE_REGISTRATION_RESULT="failed"
  return 1
}

native_services_online() {
  local butler_bun="${BUTLER_BUN:-bun}"
  "$BUTLER_HOME/packages/butler-agent/scripts/service-control.sh" ps --json 2>/dev/null | "$butler_bun" -e "
    try {
      const payload = JSON.parse(await Bun.stdin.text());
      const services = Array.isArray(payload.services) ? payload.services : [];
      process.exit(services.some((service) => service.status === 'online') ? 0 : 1);
    } catch {
      process.exit(1);
    }
  " >/dev/null 2>&1
}

read_runtime_model_selection() {
  CFG_PATH="$CONFIG_PATH" "$BUTLER_BUN" -e "
    import { readFileSync } from 'fs';
    try {
      const cfg = JSON.parse(readFileSync(process.env.CFG_PATH, 'utf-8'));
      const system = cfg.system && typeof cfg.system === 'object' ? cfg.system : {};
      const runtime = typeof system.runtime === 'string' && system.runtime ? system.runtime : 'codex-api';
      const model = typeof system.butlerModel === 'string' && system.butlerModel
        ? system.butlerModel
        : typeof system.defaultModel === 'string' && system.defaultModel
          ? system.defaultModel
          : 'unknown';
      console.log([runtime, model].join('\\t'));
    } catch {
      console.log('codex-api\\tunknown');
    }
  " 2>/dev/null || printf 'codex-api\tunknown\n'
}

print_os_service_later_hint() {
  if [[ "$OS_SERVICE_REGISTRATION_RESULT" == "manual" ]]; then
    echo ""
    echo -e "  ${MUTED}OS service registration skipped.${NC}"
    echo -e "  ${MUTED}Enable automatic startup later with:${NC} ${BOLD}butler service install --yes${NC}"
  elif [[ "$OS_SERVICE_REGISTRATION_RESULT" == "registered" ]]; then
    echo ""
    echo -e "  ${SUCCESS}✓${NC} OS service registration enabled"
  elif [[ "$OS_SERVICE_REGISTRATION_RESULT" == "failed" ]]; then
    echo ""
    echo -e "  ${WARN}!${NC} OS service registration failed; Butler is running through manual native services"
    echo -e "  ${MUTED}Retry automatic startup later with:${NC} ${BOLD}butler service install --yes${NC}"
  elif [[ "$OS_SERVICE_REGISTRATION_RESULT" == "unavailable" ]]; then
    echo ""
    echo -e "  ${WARN}!${NC} OS service registration is not available in this environment"
    echo -e "  ${MUTED}Butler is running through manual native services for this session.${NC}"
    echo -e "  ${MUTED}Register automatic startup later on the host with:${NC} ${BOLD}butler service install --yes${NC}"
  elif [[ "$OS_SERVICE_REGISTRATION_RESULT" == "blocked" ]]; then
    echo ""
    echo -e "  ${WARN}!${NC} OS service registration skipped because existing Butler services are still running"
    echo -e "  ${MUTED}Stop Butler and retry automatic startup later with:${NC} ${BOLD}butler service install --yes${NC}"
  elif [[ "$OS_SERVICE_REGISTRATION_RESULT" == "failed-active" ]]; then
    echo ""
    echo -e "  ${WARN}!${NC} OS service registration needs attention, but Butler service state is online"
    echo -e "  ${MUTED}Check automatic startup later with:${NC} ${BOLD}butler service status${NC}"
  fi
}

# ─── Health Check ─────────────────────────────────────────────────────────────

health_check() {
  ui_section "Health Check"
  echo ""

  # Poll native supervisor until butler-main is online (max 30s)
  local max_wait=30 elapsed=0 status="unknown"
  while [[ $elapsed -lt $max_wait ]]; do
    status=$("$BUTLER_HOME/packages/butler-agent/scripts/service-control.sh" ps --json 2>/dev/null | "$BUTLER_BUN" -e "
      const payload = JSON.parse(await Bun.stdin.text());
      const main = payload.services?.find(p => p.serviceId === 'butler-main');
      console.log(main?.status ?? 'not_found');
    " 2>/dev/null || echo "unknown")

    if [[ "$status" == "online" ]]; then
      break
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done

  if [[ "$status" == "online" ]]; then
    ui_success "butler-main: online"
  else
    ui_warn "butler-main: $status"
    echo -e "  ${MUTED}Check logs: butler logs --service butler-main${NC}"
  fi

  # Runtime adapter and model are separate: codex-api is the transport/runtime
  # adapter; local/... or openai/... is the selected model.
  local runtime_mode model_ref
  IFS=$'\t' read -r runtime_mode model_ref < <(read_runtime_model_selection)

  ui_success "runtime adapter: ${runtime_mode}"
  if [[ -n "${model_ref:-}" && "$model_ref" != "unknown" ]]; then
    ui_success "model selected: ${model_ref}"
  else
    ui_warn "model selected: unknown"
  fi

  if [[ -n "${BOT_TOKEN:-}" && -n "${CHAT_ID:-}" ]]; then
    ui_success "telegram gateway: paired"
  fi
}

# ─── Completion Screen ───────────────────────────────────────────────────────

print_completion() {
  local version
  version="$(tr -d '[:space:]' < "$BUTLER_HOME/VERSION" 2>/dev/null || true)"
  if [[ -z "$version" ]]; then
    version=$(PKG_PATH="$BUTLER_HOME/package.json" "$BUTLER_BUN" -e "
      import { readFileSync } from 'fs';
      try {
        const pkg = JSON.parse(readFileSync(process.env.PKG_PATH, 'utf-8'));
        console.log(pkg.version || '0.0.0');
      } catch { console.log('0.0.0'); }
    " 2>/dev/null || echo "0.0.0")
  fi

  local tagline
  tagline="$(random_tagline)"

  echo ""
  echo -e "${SUCCESS}${BOLD}Butler is ready.${NC}"
  echo ""
  echo -e "  ${MUTED}v${version}${NC}"
  echo ""
  echo -e "  ${BOLD}Quick Start${NC}"
  echo ""
  printf "  ${MUTED}%-18s${NC} %s\n" "Start" "butler start"
  printf "  ${MUTED}%-18s${NC} %s\n" "Status" "butler status"
  printf "  ${MUTED}%-18s${NC} %s\n" "Logs" "butler logs --service butler-main --lines 100"
  printf "  ${MUTED}%-18s${NC} %s\n" "Help" "butler --help"
  print_os_service_later_hint
  echo ""
  echo -e "  ${INFO}\"${tagline}\"${NC}"

  echo ""

  # Footer links
  show_footer_links
}

# ─── Experimental Consent Gate ────────────────────────────────────────────────
#
# Butler enables native automation on the principal's behalf. Before any
# installation work happens, the installer asks the operator to accept or stop
# through a small choice prompt. Non-interactive installs can provide
# BUTLER_ACCEPT_EXPERIMENTAL=1. Acceptance is persisted with a fingerprint of
# the flag set so that if the flag set is ever expanded the user sees and
# records the updated notice again.
#
# The disclaimer is shown in a single language. The language is picked up
# front (see select_install_language) and stored in $INSTALL_LANG (en|ko).

INSTALL_LANG="${INSTALL_LANG:-}"

DANGEROUS_FLAGS=(
  "native-worker-execution"
  "background-service-execution"
)

# Pick the installer display language. Runs once, at the very top of main().
# Interactive installs use the same arrow-key timeline chooser as the rest of
# the installer. Non-interactive installs honor --language / $BUTLER_INSTALL_LANG,
# else derive from $LANG (ko_* -> ko), else default to en.
select_install_language() {
  if [[ -n "$INSTALL_LANG" ]]; then
    return 0
  fi

  local requested="${INSTALL_LANG_ARG:-${BUTLER_INSTALL_LANG:-}}"
  if [[ -n "$requested" ]]; then
    case "$requested" in
      en|EN|english|English) INSTALL_LANG="en" ;;
      ko|KO|korean|Korean|kr|KR) INSTALL_LANG="ko" ;;
      *) INSTALL_LANG="en" ;;
    esac
    return 0
  fi

  if ! is_non_interactive_shell; then
    local selected_language
    echo ""
    echo -e "  ${BOLD}Select language / 언어 선택${NC}"
    selected_language="$(tl_choose "English" "한국어")"
    case "$selected_language" in
      한국어|ko|KO|kr|KR) INSTALL_LANG="ko" ;;
      *) INSTALL_LANG="en" ;;
    esac
    echo ""
    return 0
  fi

  case "${LANG:-}" in
    ko_*|ko.*|ko|ko-*) INSTALL_LANG="ko" ;;
    *) INSTALL_LANG="en" ;;
  esac
}

compute_flagset_fingerprint() {
  # Deterministic SHA-256 over the sorted flag list. macOS ships shasum;
  # Linux usually ships sha256sum — try both. If neither is available, hard
  # fail: a stable-but-meaningless placeholder would let the re-run check
  # match itself forever and permanently bypass the consent gate.
  local joined
  joined="$(printf '%s\n' "${DANGEROUS_FLAGS[@]}" | LC_ALL=C sort)"
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$joined" | shasum -a 256 | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$joined" | sha256sum | awk '{print $1}'
  else
    echo "✗ Neither shasum nor sha256sum is available; cannot verify consent integrity." >&2
    echo "  Install coreutils (sha256sum) or perl (shasum) before continuing." >&2
    exit 1
  fi
}

_disclaimer_body_en() {
  cat <<'EOF'
  Butler is experimental software distributed AS-IS with no warranty.
  By proceeding you acknowledge that Butler enables the following
  native automation capabilities on your behalf:

    • Native worker execution
        Butler can run shell commands, edit files, and call MCP tools
        through its native runtime without asking for per-command
        confirmation. A prompt-injection attack could delete data,
        leak secrets, or execute arbitrary code.

    • Automated background execution
        Butler runs asynchronous workers and long-lived services
        without a human in the loop. You are responsible for API
        usage, billing, side effects, and any consequences of that
        unattended execution.

  Butler runs only on hardware you control. You are the sole operator
  and are solely responsible for everything it does. Do NOT install on
  machines holding credentials or production data you cannot afford to
  put at risk.

EOF
}

_disclaimer_body_ko() {
  cat <<'EOF'
  Butler는 무보증(AS-IS) 실험 단계 소프트웨어입니다.
  설치를 진행하면 Butler가 사용자 대신 아래의 비표준·고위험
  네이티브 자동화 기능을 활성화함에 동의한 것으로 간주됩니다:

    • 네이티브 워커 실행
        Butler는 네이티브 런타임을 통해 Bash 명령 실행, 파일 편집,
        MCP 도구 호출을 자동으로 수행할 수 있습니다. 프롬프트 주입
        공격 시 데이터 삭제·비밀 유출·임의 코드 실행 위험이 있습니다.

    • 자동 백그라운드 실행
        Butler는 사람이 개입하지 않은 상태로 비동기 워커와 장시간
        실행 서비스를 운영합니다. API 사용량, 과금, 부작용, 무인
        실행 결과에 대한 책임은 사용자 본인에게 있습니다.

  Butler는 사용자가 통제하는 하드웨어에서만 실행됩니다. 실행 결과에
  대한 모든 책임은 사용자에게 있습니다. 자격 증명이나 프로덕션
  데이터가 있는 장비에는 설치하지 마세요.

EOF
}

show_dangerous_flags_disclaimer() {
  local accept_file="$BUTLER_DATA/.accepted-experimental"
  local current_fp stored_fp=""
  current_fp="$(compute_flagset_fingerprint)"

  if [[ -f "$accept_file" ]]; then
    stored_fp="$(awk -F= '$1=="fingerprint"{print $2; exit}' "$accept_file" 2>/dev/null || true)"
    if [[ -n "$stored_fp" && "$stored_fp" == "$current_fp" ]]; then
      return 0
    fi
  fi

  select_install_language

  local title_en="EXPERIMENTAL SOFTWARE — TERMS OF SERVICE"
  local title_ko="실험 단계 소프트웨어 — 이용 약관"

  echo ""
  echo -e "${WARN}${BOLD}══════════════════════════════════════════════════════════${NC}"
  if [[ "$INSTALL_LANG" == "ko" ]]; then
    echo -e "${WARN}${BOLD}  ${title_ko}${NC}"
  else
    echo -e "${WARN}${BOLD}  ${title_en}${NC}"
  fi
  echo -e "${WARN}${BOLD}══════════════════════════════════════════════════════════${NC}"
  echo ""

  if [[ "$INSTALL_LANG" == "ko" ]]; then
    _disclaimer_body_ko
  else
    _disclaimer_body_en
  fi

  local acceptance_mode="select"
  if [[ "${BUTLER_ACCEPT_EXPERIMENTAL:-}" == "1" ]]; then
    acceptance_mode="env"
    if [[ "$INSTALL_LANG" == "ko" ]]; then
      echo -e "${INFO}  BUTLER_ACCEPT_EXPERIMENTAL=1 감지됨 — 동의가 기록됩니다.${NC}"
    else
      echo -e "${INFO}  BUTLER_ACCEPT_EXPERIMENTAL=1 detected — consent recorded.${NC}"
    fi
  elif is_non_interactive_shell; then
    if [[ "$INSTALL_LANG" == "ko" ]]; then
      echo -e "${ERROR}${BOLD}✗ 비대화형 설치는 BUTLER_ACCEPT_EXPERIMENTAL=1 환경변수가 필요합니다.${NC}" >&2
    else
      echo -e "${ERROR}${BOLD}✗ Non-interactive install requires BUTLER_ACCEPT_EXPERIMENTAL=1.${NC}" >&2
    fi
    exit 1
  else
    local choice
    if [[ "$INSTALL_LANG" == "ko" ]]; then
      echo -e "  ${BOLD}위 고지를 확인하고 설치를 계속할까요?${NC}"
    else
      echo -e "  ${BOLD}Do you accept this notice and want to continue?${NC}"
    fi
    choice="$(tl_choose "AGREE" "Not agree")"
    if [[ "$choice" != "AGREE" ]]; then
      echo ""
      if [[ "$INSTALL_LANG" == "ko" ]]; then
        echo -e "${ERROR}${BOLD}✗ 동의하지 않아 설치를 중단합니다.${NC}" >&2
      else
        echo -e "${ERROR}${BOLD}✗ Consent not granted. Aborting install.${NC}" >&2
      fi
      exit 1
    fi
  fi

  mkdir -p "$BUTLER_DATA"
  # Pre-create the file with 0600 permissions BEFORE writing any content, to
  # avoid a brief window where another user on a multi-user system could read
  # the consent record under the default umask.
  (
    umask 077
    : > "$accept_file"
  )
  chmod 600 "$accept_file" 2>/dev/null || true
  {
    echo "timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "version=$BUTLER_INSTALLER_VERSION"
    echo "fingerprint=$current_fp"
    echo "flags=$(IFS=,; echo "${DANGEROUS_FLAGS[*]}")"
    echo "lang=$INSTALL_LANG"
    echo "mode=$acceptance_mode"
  } > "$accept_file"

  if [[ "$INSTALL_LANG" == "ko" ]]; then
    echo -e "${SUCCESS}✓ 실험 단계 동의가 기록되었습니다.${NC}"
  else
    echo -e "${SUCCESS}✓ Experimental consent recorded.${NC}"
  fi
}

# ─── Main ─────────────────────────────────────────────────────────────────────

main() {
  echo ""

  # Initialize globals
  BOT_TOKEN="" CHAT_ID=""
  OS_TYPE="" ARCH_TYPE="" PKG_INSTALL="" PKG_MANAGER=""

  bootstrap_gum || true
  detect_platform

  if [[ "$RUNTIME_REPAIR_ONLY" == true ]]; then
    ensure_butler_runtime || exit 1
    exit 0
  fi

  print_installer_banner

  # Language picker — runs first so every subsequent prompt and disclaimer
  # is shown only in the selected language.
  select_install_language

  # Consent gate — must run post-banner, pre-dependency-check. Exits nonzero
  # on decline (interactive) or missing env var (non-interactive).
  show_dangerous_flags_disclaimer

  # ── Phase 1: Preparing ──

  ui_stage "Preparing"
  check_dependencies
  show_install_plan
  setup_directories
  configure_api_provider
  initialize_first_chat_onboarding_state

  # ── Phase 2: Setting Up ──

  ui_stage "Setting Up"
  setup_steward_and_transport
  if [[ "${BUTLER_SKIP_DEPS:-}" != "1" ]]; then
    install_workspace_deps
  else
    ui_section "Installing Dependencies"
    ui_success "Skipped (BUTLER_SKIP_DEPS=1)"
  fi
  install_cli_binary
  setup_shell_env

  # ── Phase 3: Finalizing ──

  ui_stage "Finalizing"
  configure_gateway
  if [[ "${BUTLER_SKIP_SERVICES:-}" != "1" ]]; then
    if select_os_service_registration; then
      setup_os_service_registration || setup_services
    else
      setup_services
    fi
    health_check
  else
    ui_section "Native Service Setup"
    ui_success "Skipped (BUTLER_SKIP_SERVICES=1)"
  fi
  print_completion
}

if [[ "${BASH_SOURCE[0]:-$0}" == "${0}" ]]; then
  main "$@"
fi
