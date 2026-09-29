#!/usr/bin/env bash
# Developer ID signing and notarization for macOS release artifacts (#243).
#
#   setup                 CI only: temp keychain + notary key from APPLE_* secrets
#   cleanup               delete the temp keychain and key (run with if: always())
#   agent <binary>        sign, notarize and verify the standalone Agent binary
#   sign-app <Butler.app> sign nested code inside-out, then the app
#   sign-dmg <file.dmg>   sign the disk image
#   notarize <path>       submit and wait; staple .app/.dmg (a bare binary can't be)
#   verify-agent|verify-app|verify-dmg <path>
#
# Driven by env. Without BUTLER_SIGN_IDENTITY every command except setup and
# cleanup logs one line and exits 0, so PR CI and local builds stay ad-hoc.
#   BUTLER_SIGN_IDENTITY  certificate SHA-1 or name ("-" = ad-hoc, self-test only)
#   BUTLER_SIGN_KEYCHAIN  keychain holding the identity (optional)
#   BUTLER_SIGN_TEAM_ID   expected Team ID on every signature (optional)
#   BUTLER_NOTARY_KEY_PATH / BUTLER_NOTARY_KEY_ID / BUTLER_NOTARY_ISSUER_ID
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
entitlements=${BUTLER_SIGN_ENTITLEMENTS:-$here/electron.entitlements.plist}
agent_identifier=com.hexpy.butler.agent
tmp_dir=${RUNNER_TEMP:-${TMPDIR:-/tmp}}
default_keychain=$tmp_dir/butler-signing.keychain-db
key_dir=$tmp_dir/butler-signing-keys

log() { printf 'sign: %s\n' "$*"; }
die() { printf 'sign: error: %s\n' "$*" >&2; exit 1; }
enabled() { [ -n "${BUTLER_SIGN_IDENTITY:-}" ]; }
adhoc() { [ "${BUTLER_SIGN_IDENTITY:-}" = "-" ]; }

# ---- CI credentials ---------------------------------------------------------

setup() {
  [ "${GITHUB_ACTIONS:-}" = true ] || die "setup runs only in GitHub Actions"
  local names="APPLE_DEVELOPER_ID_P12_BASE64 APPLE_DEVELOPER_ID_P12_PASSWORD APPLE_API_KEY_ID APPLE_API_ISSUER_ID APPLE_API_KEY_P8 APPLE_TEAM_ID"
  local set_count=0 name
  for name in $names; do
    if [ -n "${!name:-}" ]; then set_count=$((set_count + 1)); fi
  done
  if [ "$set_count" -eq 0 ] && [ "${BUTLER_SIGN_REQUIRED:-}" != 1 ]; then
    log "no signing secrets; release stays ad-hoc"
    return 0
  fi
  [ "$set_count" -eq 6 ] || die "signing secrets missing or partial ($set_count/6 set)"

  local pw kc="$default_keychain" p12 g2 identity key g2_note=""
  pw=$(openssl rand -base64 24)
  echo "::add-mask::$pw"
  umask 077
  mkdir -p "$key_dir"
  p12=$key_dir/cert.p12
  printf '%s' "$APPLE_DEVELOPER_ID_P12_BASE64" | base64 --decode > "$p12"
  security create-keychain -p "$pw" "$kc"
  security set-keychain-settings -lut 21600 "$kc"
  security unlock-keychain -p "$pw" "$kc"
  security import "$p12" -k "$kc" -P "$APPLE_DEVELOPER_ID_P12_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security >/dev/null
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$pw" "$kc" >/dev/null
  # Apple's public intermediate, so the chain builds; a failure surfaces at verify.
  g2=$key_dir/DeveloperIDG2CA.cer
  if curl -fsSL --retry 3 -o "$g2" https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer; then
    security import "$g2" -k "$kc" >/dev/null || g2_note=" (Developer ID G2 intermediate import failed)"
  else
    g2_note=" (Developer ID G2 intermediate could not be fetched)"
  fi
  if [ -n "$g2_note" ]; then log "warning:$g2_note"; fi
  # Prepend to the user search list; delete-keychain in cleanup removes it again.
  # shellcheck disable=SC2046
  security list-keychains -d user -s "$kc" $(security list-keychains -d user | tr -d '"')
  rm -f "$p12" "$g2"

  identity=$(security find-identity -v -p codesigning "$kc" |
    awk -v team="($APPLE_TEAM_ID)" '/Developer ID Application/ && index($0, team) {print $2; exit}')
  [ -n "$identity" ] || die "no Developer ID Application identity for the configured team$g2_note"

  key=$key_dir/AuthKey.p8
  if printf '%s' "$APPLE_API_KEY_P8" | grep -q -- '-----BEGIN'; then
    printf '%s\n' "$APPLE_API_KEY_P8" > "$key"
  else
    printf '%s' "$APPLE_API_KEY_P8" | base64 --decode > "$key"
  fi
  xcrun notarytool history --key "$key" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER_ID" >/dev/null ||
    die "notary API key rejected by App Store Connect"
  {
    echo "BUTLER_SIGN_IDENTITY=$identity"
    echo "BUTLER_SIGN_KEYCHAIN=$kc"
    echo "BUTLER_SIGN_TEAM_ID=$APPLE_TEAM_ID"
    echo "BUTLER_NOTARY_KEY_PATH=$key"
    echo "BUTLER_NOTARY_KEY_ID=$APPLE_API_KEY_ID"
    echo "BUTLER_NOTARY_ISSUER_ID=$APPLE_API_ISSUER_ID"
    echo "BUTLER_APP_REQUIRE_PRODUCTION_SIGNING=1"
  } >> "$GITHUB_ENV"
  log "signing identity ready for team $APPLE_TEAM_ID"
}

cleanup() {
  local kc=${BUTLER_SIGN_KEYCHAIN:-$default_keychain}
  if [ -e "$kc" ]; then
    security delete-keychain "$kc" || log "warning: keychain delete failed"
  fi
  rm -rf "$key_dir"
  log "keychain and keys removed"
}

# ---- signing ----------------------------------------------------------------

# sign_path <path> [extra codesign args]: secure timestamp; hardened runtime
# unless BUTLER_SIGN_NO_RUNTIME=1 (disk images). A read-only payload file (and
# its directory) is made writable just for the call.
sign_path() {
  local path=$1 mode="" dmode="" dir=""
  shift
  local args=(--force --sign "$BUTLER_SIGN_IDENTITY")
  if [ "${BUTLER_SIGN_NO_RUNTIME:-}" != 1 ]; then args+=(--options runtime); fi
  if ! adhoc; then args+=(--timestamp); fi
  if [ -n "${BUTLER_SIGN_KEYCHAIN:-}" ]; then args+=(--keychain "$BUTLER_SIGN_KEYCHAIN"); fi
  if [ -f "$path" ]; then
    dir=$(dirname "$path")
    mode=$(stat -f %Lp "$path")
    dmode=$(stat -f %Lp "$dir")
    chmod u+w "$path" "$dir"
  fi
  codesign "${args[@]}" "$@" "$path"
  if [ -n "$mode" ]; then
    chmod "$mode" "$path"
    chmod "$dmode" "$dir"
  fi
}

# assert_signed <path>: valid, expected team, secure timestamp, hardened runtime
# (the last unless BUTLER_SIGN_NO_RUNTIME=1). Ad-hoc self-tests check validity only.
assert_signed() {
  local path=$1 info
  codesign --verify --strict "$path" || die "invalid signature: $path"
  if adhoc; then return 0; fi
  info=$(codesign -dv --verbose=4 "$path" 2>&1)
  if [ -n "${BUTLER_SIGN_TEAM_ID:-}" ]; then
    printf '%s\n' "$info" | grep -q "^TeamIdentifier=$BUTLER_SIGN_TEAM_ID\$" || die "wrong team: $path"
  fi
  printf '%s\n' "$info" | grep -q '^Timestamp=' || die "no secure timestamp: $path"
  if [ "${BUTLER_SIGN_NO_RUNTIME:-}" != 1 ]; then
    printf '%s\n' "$info" | grep -Eq '^CodeDirectory .*flags=0x[0-9a-f]+\(.*runtime' || die "no hardened runtime: $path"
  fi
}

# The executable a bundle's own signature covers; it is signed with the bundle.
is_bundle_main() {
  local f=$1 name rest
  case "$f" in
    */Contents/MacOS/*) return 0 ;;
    *.framework/Versions/*/*)
      name=${f%%.framework/*}
      name=${name##*/}
      rest=${f#*.framework/Versions/}
      [ "${rest#*/}" = "$name" ] && return 0
      ;;
  esac
  return 1
}

sign_app() {
  local app=${1%/} list files bundles f b
  [ -d "$app/Contents" ] || die "not an app bundle: $app"
  [ -f "$entitlements" ] || die "entitlements missing: $entitlements"
  list=$(mktemp)
  files=$(mktemp)
  bundles=$(mktemp)

  # 1. Loose Mach-O code (agent, dylibs, helper tools), not bundle main executables.
  find "$app" -type f -print0 | xargs -0 file | sed -n 's/: *Mach-O .*$//p' > "$list"
  while IFS= read -r f; do
    if is_bundle_main "$f"; then continue; fi
    printf '%s\n' "$f" >> "$files"
  done < "$list"
  while IFS= read -r f; do
    case "$f" in
      */bundled-agent/bin/butler-agent) sign_path "$f" --identifier "$agent_identifier" ;;
      *) sign_path "$f" ;;
    esac
  done < "$files"

  # 2. Nested bundles, deepest first (frameworks, helper apps, login item), then the app.
  find "$app" -mindepth 1 -type d \( -name '*.app' -o -name '*.framework' \) |
    awk '{print gsub("/", "/") "\t" $0}' | sort -rn | cut -f2- > "$bundles"
  while IFS= read -r b; do
    case "$b" in
      */Contents/Frameworks/*.app) sign_path "$b" --entitlements "$entitlements" ;;
      *) sign_path "$b" ;;
    esac
  done < "$bundles"
  sign_path "$app" --entitlements "$entitlements"

  codesign --verify --strict --deep "$app" || die "app failed deep verification"
  while IFS= read -r f; do assert_signed "$f"; done < "$files"
  while IFS= read -r b; do assert_signed "$b"; done < "$bundles"
  assert_signed "$app"
  rm -f "$list" "$files" "$bundles"
  log "signed $(basename "$app")"
}

sign_dmg() {
  BUTLER_SIGN_NO_RUNTIME=1 sign_path "$1"
  BUTLER_SIGN_NO_RUNTIME=1 assert_signed "$1"
  log "signed $(basename "$1")"
}

# ---- notarization -----------------------------------------------------------

notarize() {
  local path=${1%/} work sub out status id i
  if [ -z "${BUTLER_NOTARY_KEY_PATH:-}" ] || [ -z "${BUTLER_NOTARY_KEY_ID:-}" ] ||
    [ -z "${BUTLER_NOTARY_ISSUER_ID:-}" ]; then
    die "notary API key env is incomplete"
  fi
  local auth=(--key "$BUTLER_NOTARY_KEY_PATH" --key-id "$BUTLER_NOTARY_KEY_ID" --issuer "$BUTLER_NOTARY_ISSUER_ID")
  work=$(mktemp -d)
  case "$path" in
    *.dmg|*.zip|*.pkg) sub=$path ;;
    *) sub=$work/$(basename "$path").zip; ditto -c -k --keepParent "$path" "$sub" ;;
  esac
  log "notarizing $(basename "$path")"
  # A missing status means upload/network trouble, not a verdict: retry those only.
  for i in 1 2 3; do
    out=$(xcrun notarytool submit "$sub" "${auth[@]}" --wait --output-format json) || true
    status=$(printf '%s' "$out" | sed -n 's/.*"status" *: *"\([^"]*\)".*/\1/p' | head -n 1)
    id=$(printf '%s' "$out" | sed -n 's/.*"id" *: *"\([^"]*\)".*/\1/p' | head -n 1)
    if [ -n "$status" ]; then break; fi
    log "notarytool gave no verdict (attempt $i/3)"
    sleep 20
  done
  rm -rf "$work"
  if [ "$status" != Accepted ]; then
    if [ -n "$id" ]; then xcrun notarytool log "$id" "${auth[@]}" || true; fi
    die "notarization ${status:-failed} for $(basename "$path")"
  fi
  log "notarized $(basename "$path") ($id)"
  case "$path" in
    *.app|*.dmg|*.pkg)
      for i in 1 2 3 4 5; do
        if xcrun stapler staple "$path"; then return 0; fi
        log "staple retry $i"
        sleep 15
      done
      die "staple failed: $path"
      ;;
  esac
}

# ---- verification -----------------------------------------------------------

# gatekeeper <spctl args>: require the Notarized Developer ID source. Hosts with
# assessments disabled (override=security disabled) pass with a warning; the
# stapled ticket checked before this call is the proof there.
gatekeeper() {
  local out
  if ! out=$(spctl -a -vv "$@" 2>&1); then
    printf '%s\n' "$out" >&2
    return 1
  fi
  if printf '%s\n' "$out" | grep -q '^source=Notarized Developer ID$'; then return 0; fi
  if printf '%s\n' "$out" | grep -q '^override=security disabled$'; then
    log "warning: Gatekeeper assessments are disabled on this host"
    return 0
  fi
  printf '%s\n' "$out" >&2
  return 1
}

verify_app() {
  local app=${1%/}
  codesign --verify --strict --deep --verbose=2 "$app" || die "app failed deep verification"
  assert_signed "$app"
  xcrun stapler validate "$app" || die "app is not stapled"
  gatekeeper -t exec "$app" || die "Gatekeeper does not accept the app as notarized"
}

verify_dmg() {
  BUTLER_SIGN_NO_RUNTIME=1 assert_signed "$1"
  xcrun stapler validate "$1" || die "dmg is not stapled"
  gatekeeper -t open --context context:primary-signature "$1" || die "Gatekeeper does not accept the dmg as notarized"
}

# A bare binary can't be stapled: check the online ticket. It can lag the
# notarization verdict briefly, so retry a few times.
verify_agent() {
  local i
  assert_signed "$1"
  for i in 1 2 3; do
    if codesign --verify -R='=notarized' --check-notarization "$1"; then return 0; fi
    sleep 15
  done
  die "agent has no notarization ticket: $1"
}

agent() {
  [ -f "$1" ] || die "agent binary missing: $1"
  sign_path "$1" --identifier "$agent_identifier"
  assert_signed "$1"
  notarize "$1"
  verify_agent "$1"
  log "agent signed and notarized"
}

# ---- dispatch ---------------------------------------------------------------

command=${1:-}
[ -n "$command" ] || die "usage: $(basename "$0") <command> [path]"
shift
case "$command" in
  setup) setup; exit 0 ;;
  cleanup) cleanup; exit 0 ;;
esac
if ! enabled; then
  log "no BUTLER_SIGN_IDENTITY; skipping $command (ad-hoc build)"
  exit 0
fi
[ $# -ge 1 ] || die "$command needs a path"
case "$command" in
  agent) agent "$1" ;;
  sign-app) sign_app "$1" ;;
  sign-dmg) sign_dmg "$1" ;;
  notarize) notarize "$1" ;;
  verify-agent) verify_agent "$1" ;;
  verify-app) verify_app "$1" ;;
  verify-dmg) verify_dmg "$1" ;;
  *) die "unknown command: $command" ;;
esac
