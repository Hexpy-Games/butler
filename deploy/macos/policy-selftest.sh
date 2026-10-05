#!/usr/bin/env bash
# test-category: pure-logic
# Exercise the release entry points with fake Apple tools, without credentials.
set -euo pipefail
script=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/sign-and-notarize.sh
work=$(mktemp -d)
trap 'if [ $? -ne 0 ] && [ -f "$work/log" ]; then sed "/::add-mask::/d" "$work/log" >&2; fi; rm -rf "$work"' EXIT
mkdir -p "$work/bin"
export RUNNER_TEMP="$work" GITHUB_ENV="$work/env" GITHUB_ACTIONS=true
export BUTLER_SIGN_REQUIRED=1 POLICY_CALLS="$work/calls"
export APPLE_DEVELOPER_ID_P12_BASE64=ZmFrZQ== APPLE_DEVELOPER_ID_P12_PASSWORD=fake
export APPLE_TEAM_ID=FAKETEAM APPLE_API_KEY_ID=fake APPLE_API_ISSUER_ID=fake APPLE_API_KEY_P8=fake
cat > "$work/bin/openssl" <<'MOCK'
#!/usr/bin/env bash
echo fake-keychain-password
MOCK
cat > "$work/bin/security" <<'MOCK'
#!/usr/bin/env bash
set -eu
if [ "${POLICY_CERT_FAIL:-}" = 1 ]; then exit 1; fi
[ "$HOME" = "$POLICY_RUNNER_HOME" ] || { echo "credential profile mismatch" >&2; exit 33; }
if [ "$1" = find-identity ]; then echo '1) ABCDEF "Developer ID Application: Fake (FAKETEAM)"'; fi
MOCK
cat > "$work/bin/curl" <<'MOCK'
#!/usr/bin/env bash
exit 0
MOCK
cat > "$work/bin/xcrun" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$POLICY_CALLS"
exit 1
MOCK
cat > "$work/bin/codesign" <<'MOCK'
#!/usr/bin/env bash
if [ "$1" = --force ] && [ "${BUTLER_SIGN_IDENTITY:-}" = ABCDEF ]; then
  [ "$HOME" = "$POLICY_RUNNER_HOME" ] || { echo "signing profile mismatch" >&2; exit 34; }
fi
if [ "$1" = -dv ]; then
  printf 'TeamIdentifier=FAKETEAM\nTimestamp=fake\nCodeDirectory flags=0x10000(runtime)\n' >&2
fi
exit 0
MOCK
chmod +x "$work/bin/"*
export PATH="$work/bin:$PATH"
# Codesign only finds the identity under the runner HOME whose keychain search
# list setup changed; isolated steps must sign with that HOME, not their own.
export POLICY_RUNNER_HOME="$work/runner-home"
mkdir -p "$POLICY_RUNNER_HOME"
export GITHUB_REF_NAME=v0.1.0-preview.1
HOME="$POLICY_RUNNER_HOME" "$script" setup > "$work/log" 2>&1
if [ -e "$POLICY_CALLS" ] || [ -e "$work/butler-signing-keys/AuthKey.p8" ]; then
  echo 'preview used notary credentials' >&2; exit 1
fi
grep -q '^BUTLER_SIGN_IDENTITY=ABCDEF$' "$GITHUB_ENV"
grep -Fxq "BUTLER_SIGN_HOME=$POLICY_RUNNER_HOME" "$GITHUB_ENV"
mkdir -p "$work/Fake.app/Contents"
printf 'fake plist\n' > "$work/Fake.app/Contents/Info.plist"
# Isolated HOME differs: only credential tools use the runner profile.
HOME="$work/isolated-home" BUTLER_SIGN_IDENTITY=ABCDEF BUTLER_SIGN_HOME="$POLICY_RUNNER_HOME" \
  "$script" sign-app "$work/Fake.app" > "$work/log" 2>&1
HOME="$POLICY_RUNNER_HOME" BUTLER_SIGN_HOME="$POLICY_RUNNER_HOME" "$script" cleanup > "$work/log" 2>&1
[ -d "$POLICY_RUNNER_HOME" ] || { echo 'cleanup removed the runner HOME' >&2; exit 1; }
export POLICY_CERT_FAIL=1
: > "$GITHUB_ENV"
HOME="$POLICY_RUNNER_HOME" "$script" setup > "$work/log" 2>&1
grep -q '^BUTLER_SIGN_IDENTITY=-$' "$GITHUB_ENV"
unset POLICY_CERT_FAIL
export BUTLER_SIGN_IDENTITY=-
for command in notarize verify-agent verify-app verify-dmg; do
  "$script" "$command" "$work/Fake.app" > "$work/log" 2>&1
done
[ ! -e "$POLICY_CALLS" ] || { echo 'preview called notary/stapler' >&2; exit 1; }
echo 'policy: preview preserves Developer ID, falls back to ad-hoc, skips notary/stapler'
export GITHUB_REF_NAME=v0.1.0
if "$script" verify-agent "$work/agent" > "$work/log" 2>&1; then
  echo 'stable accepted ad-hoc signing' >&2; exit 1
fi
export BUTLER_SIGN_IDENTITY=ABCDEF
if HOME="$POLICY_RUNNER_HOME" "$script" setup > "$work/log" 2>&1; then
  echo 'stable accepted rejected notary credentials' >&2; exit 1
fi
grep -q 'notarytool history' "$POLICY_CALLS"
if env -u BUTLER_NOTARY_KEY_PATH "$script" notarize "$work/agent" > "$work/log" 2>&1; then
  echo 'stable accepted missing notary credentials' >&2; exit 1
fi
if "$script" verify-dmg "$work/Fake.dmg" > "$work/log" 2>&1; then
  echo 'stable accepted missing staple' >&2; exit 1
fi
grep -q 'stapler validate' "$POLICY_CALLS"
export POLICY_CERT_FAIL=1
if HOME="$POLICY_RUNNER_HOME" "$script" setup > "$work/log" 2>&1; then
  echo 'stable accepted certificate setup failure' >&2; exit 1
fi
echo 'policy: stable requires Developer ID and valid notary credentials'
