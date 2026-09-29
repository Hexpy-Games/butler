#!/bin/sh
# Installs the Butler agent and its `butler` command (macOS arm64, Linux x64/arm64).
#
#   curl -fsSL https://github.com/Hexpy-Games/butler/releases/latest/download/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --version 0.0.22 --no-start
#
# Layout and rules: packages/butler-agent/rust/docs/install-layout.md
# Never touches DATA (~/.butler). Safe to re-run.
set -eu
umask 022

REPO="Hexpy-Games/butler"
MARKER="# butler-native-launcher v1"

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
                            (needs BUTLER_VERSION)
EOF
}

die() { echo "butler-install: error: $*" >&2; exit 1; }
info() { echo "butler-install: $*"; }

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

# --- platform and prerequisites ----------------------------------------------

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
for tool in curl tar awk sed; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
done
if command -v sha256sum >/dev/null 2>&1; then
  sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  die "sha256sum or shasum is required"
fi

# --- paths ---------------------------------------------------------------------

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

# --- version and download ------------------------------------------------------

if [ -z "$version" ]; then
  [ -z "${BUTLER_INSTALL_BASE_URL:-}" ] || die "set BUTLER_VERSION when BUTLER_INSTALL_BASE_URL is used"
  latest="$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")" ||
    die "could not look up the latest release"
  case "$latest" in
    */releases/tag/v*) version="${latest##*/tag/v}" ;;
    *) die "no published Butler release found" ;;
  esac
fi
version="${version#v}"
base="${BUTLER_INSTALL_BASE_URL:-https://github.com/$REPO/releases/download/v$version}"
base="${base%/}"
archive="butler-agent-$version-$platform.tar.gz"
sums="butler-$version-SHA256SUMS"

tmp="$(mktemp -d)"
staging=""
cleanup() {
  rm -rf "$tmp"
  if [ -n "$staging" ]; then
    chmod -R u+w "$staging" 2>/dev/null || true
    rm -rf "$staging"
  fi
}
trap cleanup EXIT
trap 'exit 1' INT TERM HUP

fetch() { curl -fsSL --retry 3 -o "$2" "$1" || die "download failed: $1"; }

info "installing Butler $version ($platform)"
fetch "$base/$sums" "$tmp/$sums"
fetch "$base/$archive" "$tmp/$archive"
expected="$(awk -v name="$archive" '{ n = $2; sub(/^\*/, "", n) } n == name { print $1 }' "$tmp/$sums")"
[ -n "$expected" ] || die "$archive is not listed in $sums"
[ "$(sha256_of "$tmp/$archive")" = "$expected" ] || die "checksum mismatch for $archive"

# --- extract into a version dir ------------------------------------------------

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
agent_version="$(field version)"
binary_sha="$(field binarySha256)"
[ "$(field platform)-$(field architecture)" = "$platform" ] || die "$archive was built for another platform"
printf '%s' "$binary_sha" | grep -Eq '^[0-9a-f]{64}$' || die "$archive has an invalid manifest"
[ -n "$agent_version" ] || die "$archive has an invalid manifest"
dir="$agent_version-$(printf '%s' "$binary_sha" | cut -c1-8)"

if [ -d "$AGENT_HOME/$dir" ]; then
  info "$dir is already installed"
else
  mv "$staging" "$AGENT_HOME/$dir"
  staging=""
fi

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

old="$(readlink "$AGENT_HOME/current" 2>/dev/null || true)"
if [ "$old" != "$dir" ]; then
  if [ -n "$old" ] && [ -d "$AGENT_HOME/$old" ]; then set_link previous "$old"; fi
  set_link current "$dir"
fi

# --- the `butler` command ------------------------------------------------------

sq() { printf "'"; printf '%s' "$1" | sed "s/'/'\\\\''/g"; printf "'"; }

launcher="$BIN_DIR/butler"
mkdir -p "$BIN_DIR"
if [ -e "$launcher" ] || [ -L "$launcher" ]; then
  [ "$(sed -n 2p "$launcher" 2>/dev/null || true)" = "$MARKER" ] ||
    die "$launcher exists and is not a Butler launcher; move it away and re-run"
fi
new_launcher="$BIN_DIR/.butler.$$"
{
  printf '#!/bin/sh\n%s\n# Managed by Butler: rewritten by the installer.\n' "$MARKER"
  printf 'exec %s --installation-root %s --resource-root %s "$@"\n' \
    "$(sq "$AGENT_HOME/current/butler-agent")" "$(sq "$AGENT_HOME/current")" "$(sq "$AGENT_HOME/current/resources")"
} > "$new_launcher"
chmod 755 "$new_launcher"
mv -f "$new_launcher" "$launcher"

# --- PATH ----------------------------------------------------------------------

on_path=1
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) on_path=0 ;; esac
if [ "$on_path" = 0 ]; then
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
fi

# --- verify and start ----------------------------------------------------------

if ! report="$("$launcher" doctor --check installation 2>&1 </dev/null)"; then
  echo "$report" >&2
  die "the installation failed its self-check"
fi
info "installed $dir at $AGENT_HOME"
if [ "$start" = 1 ]; then
  "$launcher" start </dev/null || die "installed, but Butler did not start; try: butler start"
  [ -z "$old" ] || [ "$old" = "$dir" ] || info "if Butler was already running, apply the update with: butler restart"
else
  info "start it with: butler start"
fi
