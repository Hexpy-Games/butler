import json, os, pathlib, plistlib, shutil, subprocess, datetime
root = pathlib.Path(__file__).resolve().parents[1]
default_pump_ms = int(os.environ.get('SPIKE_PUMP_MS', '33'))
final = root / 'dist/ButlerCefSpike.app'
app = root / 'dist/ButlerCefSpike.build.app'
if app.exists(): shutil.rmtree(app)
contents = app / 'Contents'
for path in ('MacOS', 'Frameworks', 'Resources'):
    (contents / path).mkdir(parents=True, exist_ok=True)
source = root / 'target/release/butler-cef-spike'
shutil.copy2(source, contents / 'MacOS/ButlerCefSpike-bin')
# The launcher isolates every open -n launch without unsafe Rust env mutation.
launcher = contents / 'MacOS/ButlerCefSpike'
launcher.write_text(f'''#!/bin/bash
set -eu
ROOT='{root}'
if [ "${{1:-}}" != "--d4" ]; then
export HOME=$(/usr/bin/mktemp -d "$ROOT/home-run.XXXXXX")
export BUTLER_DATA=$(/usr/bin/mktemp -d "$ROOT/data-run.XXXXXX")
export TMPDIR=$(/usr/bin/mktemp -d "$ROOT/tmp-run.XXXXXX")
fi
export MallocNanoZone=0
export OS_ACTIVITY_MODE=disable
/bin/rm -rf "$ROOT/profile"
/bin/mkdir -p "$ROOT/profile"
exec /usr/bin/nice -n 10 "$(/usr/bin/dirname "$0")/ButlerCefSpike-bin" "$@" --pump-max-ms {default_pump_ms} --use-mock-keychain --password-store=basic --disable-crash-reporter --disable-breakpad --disable-component-update
''')
launcher.chmod(0o755)
base = dict(CFBundleName='ButlerCefSpike', CFBundleDisplayName='Butler CEF Spike',
            CFBundleIdentifier='games.hexpy.butler-cef-spike', CFBundleExecutable='ButlerCefSpike',
            CFBundlePackageType='APPL', CFBundleInfoDictionaryVersion='6.0',
            CFBundleVersion='0.1.0', CFBundleShortVersionString='0.1.0',
            LSMinimumSystemVersion='11.0', NSHighResolutionCapable=True,
            NSSupportsAutomaticGraphicsSwitching=True)
with (contents / 'Info.plist').open('wb') as file:
    plistlib.dump(base, file)
framework = contents / 'Frameworks/Chromium Embedded Framework.framework'
if not framework.exists():
    shutil.copytree(root / 'cef/Chromium Embedded Framework.framework', framework, symlinks=True)
for suffix in ('Helper', 'Helper (GPU)', 'Helper (Renderer)', 'Helper (Plugin)', 'Helper (Alerts)'):
    name = 'ButlerCefSpike ' + suffix
    helper = contents / 'Frameworks' / (name + '.app') / 'Contents'
    (helper / 'MacOS').mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, helper / 'MacOS' / name)
    # Helpers live in Contents/Frameworks/<name>.app/Contents/MacOS; point the launch-time framework link there.
    subprocess.run(['install_name_tool', '-change',
        '@executable_path/../Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework',
        '@executable_path/../../../Chromium Embedded Framework.framework/Chromium Embedded Framework',
        str(helper / 'MacOS' / name)], check=True)
    info = dict(base, CFBundleName=name, CFBundleExecutable=name, LSUIElement=True)
    with (helper / 'Info.plist').open('wb') as file:
        plistlib.dump(info, file)
subprocess.run(['codesign', '--force', '--deep', '--sign', '-', str(app)], check=True)
subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
with (root / 'spike.log').open('a') as file:
    file.write(json.dumps({'ts':datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'event':'packaged', 'data':{'app':str(final), 'sandbox':False, 'signed':'ad-hoc'}}) + '\n')
if final.exists(): shutil.rmtree(final)
app.rename(final)
print(final)
