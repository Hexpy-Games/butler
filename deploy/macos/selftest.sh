#!/usr/bin/env bash
# test-category: security
# PR-safe check of sign-and-notarize.sh: no-identity mode is a no-op, and the
# inside-out order produces a valid deep signature on a synthetic Electron-shaped
# bundle (ad-hoc identity "-", no keychain, no network). macOS only.
set -euo pipefail

script=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/sign-and-notarize.sh
work=$(mktemp -d)
trap 'chmod -R u+w "$work"; rm -rf "$work"' EXIT

out=$(env -u BUTLER_SIGN_IDENTITY "$script" sign-app "$work/none.app")
printf '%s\n' "$out" | grep -q 'skipping sign-app' || { echo "no-identity mode did not skip" >&2; exit 1; }

app=$work/Fake.app
fw=$app/Contents/Frameworks/Lib.framework
helper=$app/Contents/Frameworks/Fake\ Helper.app
plist() { # plist <path> <bundle id> <executable> <package type>
  printf '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>%s</string><key>CFBundleExecutable</key><string>%s</string><key>CFBundlePackageType</key><string>%s</string></dict></plist>\n' "$2" "$3" "$4" > "$1"
}
exe() { clang -x c - -o "$1" <<< 'int main(void){return 0;}'; }

mkdir -p "$app/Contents/MacOS" "$helper/Contents/MacOS" "$fw/Versions/A/Libraries" \
  "$fw/Versions/A/Resources" "$app/Contents/Resources/bundled-agent/bin"
plist "$app/Contents/Info.plist" test.fake Fake APPL
plist "$helper/Contents/Info.plist" test.fake.helper "Fake Helper" APPL
plist "$fw/Versions/A/Resources/Info.plist" test.fake.lib Lib FMWK
exe "$app/Contents/MacOS/Fake"
exe "$helper/Contents/MacOS/Fake Helper"
exe "$fw/Versions/A/Lib"
exe "$app/Contents/Resources/bundled-agent/bin/butler-agent"
clang -dynamiclib -x c - -o "$fw/Versions/A/Libraries/libx.dylib" <<< 'int x(void){return 1;}'
ln -s A "$fw/Versions/Current"
ln -s Versions/Current/Lib "$fw/Lib"
ln -s Versions/Current/Resources "$fw/Resources"
chmod 555 "$app/Contents/Resources/bundled-agent/bin/butler-agent" "$app/Contents/Resources/bundled-agent/bin"

BUTLER_SIGN_IDENTITY=- "$script" sign-app "$app"
codesign --verify --strict --deep "$app"
codesign -d --verbose=2 "$app/Contents/Resources/bundled-agent/bin/butler-agent" 2>&1 |
  grep -q 'Identifier=com.hexpy.butler.agent' || { echo "agent identifier missing" >&2; exit 1; }
codesign -d --entitlements - "$app" 2>&1 | grep -q allow-jit || { echo "app entitlements missing" >&2; exit 1; }
[ "$(stat -f %Lp "$app/Contents/Resources/bundled-agent/bin/butler-agent")" = 555 ] || { echo "agent mode not restored" >&2; exit 1; }
# Unofficial previews still verify real signatures, without an online ticket.
export GITHUB_REF_NAME=v0.1.0-preview.1 BUTLER_SIGN_IDENTITY=-
"$script" agent "$app/Contents/Resources/bundled-agent/bin/butler-agent"
"$script" verify-app "$app"
python3 - "$script" "$app/Contents/Resources/bundled-agent/bin/butler-agent" <<'PYTEST'
import importlib.util
import os
from pathlib import Path
import sys
packager = Path(sys.argv[1]).parents[2] / "packages/butler-agent/rust/scripts/package-standalone-agent.py"
spec = importlib.util.spec_from_file_location("packager", packager)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert module.binary_signing(Path(sys.argv[2])) == {"teamId": "", "notarized": False}
os.environ["GITHUB_REF_NAME"] = "v0.1.0"
assert module.binary_signing(Path(sys.argv[2])) is None
PYTEST
echo "selftest: ok"
