#!/bin/sh
# Installs the Butler agent and its `butler` command (macOS arm64, Linux x64/arm64).
#
#   curl -fsSL https://github.com/Hexpy-Games/butler/releases/latest/download/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --version X.Y.Z --no-start
#
# Layout and rules: packages/butler-agent/rust/docs/install-layout.md
# Never touches DATA (~/.butler). Safe to re-run.
#
# Everything runs from main() at the bottom, so a truncated download runs nothing.
# Steps that only place files (unpack .. install_launcher) are what
# `butler install --from <archive> --sha256 <hex>` does once that is used instead.
set -eu
umask 022

REPO="Hexpy-Games/butler"
MARKER="# butler-native-launcher v1"
SCHEMA="butler.native-agent-install.v1"
VERSION_PATTERN='^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'

usage() {
  cat <<'EOF'
Usage: install.sh [--version X.Y.Z] [--no-start] [--modify-path]

  --version X.Y.Z   install this release instead of the latest (or set BUTLER_VERSION)
  --no-start        do not start Butler after installing
  --modify-path     add ~/.local/bin to your shell profile if it is not on PATH

Environment:
  BUTLER_AGENT_HOME         install directory (default: per OS, see install-layout.md)
  BUTLER_BIN_DIR            where the `butler` command goes (default: ~/.local/bin)
  BUTLER_INSTALL_BASE_URL   fetch archive and SHA256SUMS from here instead of GitHub
                            (needs BUTLER_VERSION; plain http allowed)
  BUTLER_ALLOW_ROOT=1       allow installing as root
EOF
}

die() { echo "butler-install: error: $*" >&2; exit 1; }
info() { echo "butler-install: $*"; }

# HTTPS only (also across redirects), unless a test base URL is in use.
curl_safe() {
  if [ -n "${BUTLER_INSTALL_BASE_URL:-}" ]; then
    curl "$@"
  else
    curl --proto '=https' --tlsv1.2 "$@"
  fi
}

fetch() { curl_safe -fsSL --retry 3 -o "$2" "$1" || die "download failed: $1"; }

valid_version() {
  printf '%s' "$1" | grep -Eq "$VERSION_PATTERN" && case "$1" in *..*) return 1 ;; esac
}

# --- arguments, platform, paths ------------------------------------------------

parse_args() {
  version="${BUTLER_VERSION:-}"
  start=1
  modify_path=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --version) [ $# -ge 2 ] || die "--version needs a value"; version="$2"; shift 2 ;;
      --version=*) version="${1#*=}"; shift ;;
      --no-start) start=0; shift ;;
      --modify-path) modify_path=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown option: $1 (see --help)" ;;
    esac
  done
  version="${version#v}"
  [ -z "$version" ] || valid_version "$version" || die "invalid version: $version"
}

check_environment() {
  if [ "$(id -u)" = 0 ] && [ "${BUTLER_ALLOW_ROOT:-}" != 1 ]; then
    die "refusing to install as root (Butler is a per-user install); re-run as your user, or set BUTLER_ALLOW_ROOT=1"
  fi
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) die "unsupported OS: $os (a Windows installer is planned)" ;;
  esac
  case "$arch" in
    arm64|aarch64) arch=arm64 ;;
    x86_64|amd64) arch=x64 ;;
    *) die "unsupported CPU: $arch" ;;
  esac
  platform="$os-$arch"
  case "$platform" in
    darwin-arm64|linux-x64|linux-arm64) ;;
    *) die "no Butler agent build for $platform" ;;
  esac
  if [ "$os" = linux ]; then
    case "$(ldd --version 2>&1 || true)" in
      *musl*) die "musl libc (Alpine) is not supported; the agent needs glibc" ;;
    esac
  fi
  for tool in curl tar awk sed grep; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
  done
  if command -v sha256sum >/dev/null 2>&1; then
    sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
  elif command -v shasum >/dev/null 2>&1; then
    sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
  else
    die "sha256sum or shasum is required"
  fi
}

resolve_paths() {
  : "${HOME:?HOME is not set}"
  if [ -n "${BUTLER_AGENT_HOME:-}" ]; then
    AGENT_HOME="$BUTLER_AGENT_HOME"
  elif [ "$os" = darwin ]; then
    AGENT_HOME="$HOME/Applications/ButlerAgent"
  else
    AGENT_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/butler/agent"
  fi
  BIN_DIR="${BUTLER_BIN_DIR:-$HOME/.local/bin}"
  DATA="${BUTLER_DATA:-$HOME/.butler}"
  for path in "$AGENT_HOME" "$BIN_DIR"; do
    case "$path" in /*) ;; *) die "paths must be absolute: $path" ;; esac
  done
  case "$AGENT_HOME/" in "$DATA"/*) die "install directory $AGENT_HOME is inside the data directory $DATA" ;; esac
  case "$DATA/" in "$AGENT_HOME"/*) die "data directory $DATA is inside the install directory $AGENT_HOME" ;; esac
}

# --- download ------------------------------------------------------------------

resolve_version() {
  [ -z "$version" ] || return 0
  [ -z "${BUTLER_INSTALL_BASE_URL:-}" ] || die "set BUTLER_VERSION when BUTLER_INSTALL_BASE_URL is used"
  latest="$(curl_safe -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")" ||
    die "could not look up the latest release"
  case "${latest##*/tag/v}" in
    "$latest") die "no published Butler release found" ;;
    *) version="${latest##*/tag/v}" ;;
  esac
  valid_version "$version" || die "the latest release has an invalid version: $version"
}

# Leaves the checksum-verified archive at $tmp/$archive.
download() {
  base="${BUTLER_INSTALL_BASE_URL:-https://github.com/$REPO/releases/download/v$version}"
  base="${base%/}"
  archive="butler-agent-$version-$platform.tar.gz"
  sums="butler-$version-SHA256SUMS"
  info "installing Butler $version ($platform)"
  fetch "$base/$sums" "$tmp/$sums"
  fetch "$base/$archive" "$tmp/$archive"
  expected="$(awk -v name="$archive" '{ n = $2; sub(/^\*/, "", n) } n == name { print $1 }' "$tmp/$sums")"
  [ -n "$expected" ] || die "$archive is not listed in $sums"
  [ "$(sha256_of "$tmp/$archive")" = "$expected" ] || die "checksum mismatch for $archive; nothing was installed"
}

# --- unpack and verify ---------------------------------------------------------

# Extracts into $staging and sets agent_version, binary_sha and dir (<version>-<sha8>).
unpack() {
  mkdir -p "$AGENT_HOME"
  staging="$AGENT_HOME/.staging-$$"
  rm -rf "$staging"
  mkdir "$staging"
  tar -xzf "$tmp/$archive" -C "$staging" || die "could not extract $archive"
  manifest="$staging/native-agent-manifest.json"
  for required in native-agent-manifest.json butler-agent resources; do
    [ -e "$staging/$required" ] || die "$archive is not a Butler agent archive"
  done
  field() { sed -n "s/.*\"$1\": *\"\\([^\"]*\\)\".*/\\1/p" "$manifest" | head -n 1; }
  [ "$(field schema)" = "$SCHEMA" ] || die "$archive has an unsupported manifest"
  [ "$(field platform)-$(field architecture)" = "$platform" ] || die "$archive was built for another platform"
  agent_version="$(field version)"
  valid_version "$agent_version" || die "$archive has an invalid version"
  [ "$agent_version" = "$version" ] || die "release $version contains agent $agent_version"
  binary_sha="$(field binarySha256)"
  printf '%s' "$binary_sha" | grep -Eq '^[0-9a-f]{64}$' || die "$archive has an invalid manifest"
  dir="$agent_version-$(printf '%s' "$binary_sha" | cut -c1-8)"
}

# Runs the tree's own installation check; the binary must also match the manifest digest.
verify_tree() {
  [ "$(sha256_of "$1/butler-agent")" = "$binary_sha" ] || return 1
  "$1/butler-agent" --installation-root "$1" --resource-root "$1/resources" \
    doctor --check installation >"$tmp/doctor.out" 2>&1 </dev/null
}

verify_staging() {
  verify_tree "$staging" || {
    cat "$tmp/doctor.out" >&2
    die "the downloaded agent failed its self-check; nothing was installed"
  }
}

# --- place and activate --------------------------------------------------------

place_version() {
  target="$AGENT_HOME/$dir"
  if [ -d "$target" ] && [ ! -L "$target" ] && verify_tree "$target"; then
    info "$dir is already installed"
    return 0
  fi
  if [ -L "$target" ]; then
    rm -f "$target"
  elif [ -e "$target" ]; then
    info "replacing damaged $dir"
    aside="$AGENT_HOME/.old-$$"
    chmod -R u+w "$target" 2>/dev/null || true
    mv "$target" "$aside"
  fi
  mv "$staging" "$target"
  staging=""
  chmod -R a-w "$target" # macOS cannot rename a read-only directory, so only now
}

# Points AGENT_HOME/<name> at <target> by renaming a fresh symlink over the old
# one, so a reader never sees it missing. -T is GNU/busybox, -h is BSD/macOS.
set_link() {
  new="$AGENT_HOME/.link-$$"
  rm -f "$new"
  ln -s "$2" "$new" || die "could not create a symlink in $AGENT_HOME"
  mv -fT "$new" "$AGENT_HOME/$1" 2>/dev/null || mv -fh "$new" "$AGENT_HOME/$1" || {
    rm -f "$new"
    die "could not update $AGENT_HOME/$1"
  }
}

activate() {
  old="$(readlink "$AGENT_HOME/current" 2>/dev/null || true)"
  [ "$old" != "$dir" ] || return 0
  if [ -n "$old" ] && [ -d "$AGENT_HOME/$old" ]; then set_link previous "$old"; fi
  set_link current "$dir"
}

# --- the `butler` command ------------------------------------------------------

sq() { printf "'"; printf '%s' "$1" | sed "s/'/'\\\\''/g"; printf "'"; }

# Decides what to do with an existing $BIN_DIR/butler before anything is installed:
# ours is rewritten, the pre-native (Bun) launcher is kept aside as `butler install`
# does (it runs `$BUTLER_HOME/bin/butler.js`), anything else (or a symlink, which is never followed) stops the install.
check_launcher() {
  launcher="$BIN_DIR/butler"
  stale_launcher=0
  if [ -L "$launcher" ]; then
    die "$launcher is a symlink, not a Butler launcher; move it away and re-run"
  elif [ -e "$launcher" ]; then
    if [ "$(sed -n 2p "$launcher" 2>/dev/null || true)" = "$MARKER" ]; then
      :
    elif grep -aq 'butler\.js' "$launcher" 2>/dev/null && grep -aq 'BUTLER_HOME' "$launcher" 2>/dev/null; then
      stale_launcher=1
    else
      die "$launcher exists and is not a Butler launcher; move it away and re-run"
    fi
  fi
}

install_launcher() {
  mkdir -p "$BIN_DIR"
  if [ "$stale_launcher" = 1 ] && [ ! -e "$BIN_DIR/butler.previous" ] && [ ! -L "$BIN_DIR/butler.previous" ]; then
    mv "$launcher" "$BIN_DIR/butler.previous"
    info "kept the old launcher as $BIN_DIR/butler.previous"
  fi
  new_launcher="$BIN_DIR/.butler.$$"
  {
    printf '#!/bin/sh\n%s\n# Managed by Butler: rewritten by the installer.\n' "$MARKER"
    printf 'exec %s --installation-root %s --resource-root %s "$@"\n' \
      "$(sq "$AGENT_HOME/current/butler-agent")" "$(sq "$AGENT_HOME/current")" "$(sq "$AGENT_HOME/current/resources")"
  } > "$new_launcher"
  chmod 755 "$new_launcher"
  mv -f "$new_launcher" "$launcher"
}

path_hint() {
  case ":$PATH:" in *":$BIN_DIR:"*) return 0 ;; esac
  line="export PATH=\"$BIN_DIR:\$PATH\""
  if [ "$modify_path" = 1 ]; then
    case "${SHELL:-}" in
      */zsh) profile="$HOME/.zshrc" ;;
      */bash) if [ "$os" = darwin ]; then profile="$HOME/.bash_profile"; else profile="$HOME/.bashrc"; fi ;;
      *) profile="$HOME/.profile" ;;
    esac
    grep -qsF "$line" "$profile" || printf '\n# Butler\n%s\n' "$line" >> "$profile"
    info "added $BIN_DIR to PATH in $profile; open a new shell"
  else
    info "$BIN_DIR is not on your PATH. Add it with:  $line"
  fi
}

finish() {
  if ! report="$("$launcher" doctor --check installation 2>&1 </dev/null)"; then
    echo "$report" >&2
    die "the butler command failed its self-check"
  fi
  info "installed $dir at $AGENT_HOME"
  if [ "$start" = 1 ]; then
    "$launcher" start </dev/null || die "installed, but Butler did not start; try: butler start"
    [ -z "$old" ] || [ "$old" = "$dir" ] || info "if Butler was already running, apply the update with: butler restart"
  else
    info "start it with: butler start"
  fi
}

cleanup() {
  rm -rf "$tmp"
  for leftover in "$staging" "$aside"; do
    [ -z "$leftover" ] || { chmod -R u+w "$leftover" 2>/dev/null || true; rm -rf "$leftover"; }
  done
}

main() {
  staging=""
  aside=""
  tmp=""
  parse_args "$@"
  check_environment
  resolve_paths
  resolve_version
  check_launcher
  tmp="$(mktemp -d)"
  trap cleanup EXIT
  trap 'exit 1' INT TERM HUP
  download
  unpack
  verify_staging
  place_version
  activate
  install_launcher
  path_hint
  finish
}

main "$@"
