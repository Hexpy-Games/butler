#!/bin/bash
set -euo pipefail

SRC=${BUTLER_DEMO_SRC:-$HOME/ButlerDemo/src}
if [[ ! -e "$SRC" ]]; then
  git clone https://github.com/Hexpy-Games/butler.git "$SRC"
fi
git -C "$SRC" fetch origin main
git -C "$SRC" checkout --detach --force origin/main
SHA=$(git -C "$SRC" rev-parse --short=9 HEAD)

builds="$HOME/ButlerDemo/builds"
build="$builds/$SHA"
APP="$build/app/Butler.app"
if [[ ! -e "$APP" ]]; then
  echo "main $SHA 빌드 중…"
  (
    cd "$SRC"
    unset GITHUB_REF_NAME
    unset LIBRARY_PATH
    export CARGO_TARGET_DIR="$HOME/ButlerDemo/target"
    bun install --frozen-lockfile --ignore-scripts
    npm --prefix packages/butler-app/client/ui run build
    rm -rf -- "$build/app-out"
    bun run release:app:package -- --platform=darwin-arm64 --out "$build/app-out"
    ditto -x -k "$build/app-out/"*.zip "$build/app"
    rm -rf -- "$build/app-out"
  )
  echo "main $SHA 빌드 완료"

  newest= second_newest=
  for build_dir in "$builds"/*/; do
    if [[ "$build_dir" -nt "$newest" ]]; then
      second_newest=$newest
      newest=$build_dir
    elif [[ "$build_dir" -nt "$second_newest" ]]; then
      second_newest=$build_dir
    fi
  done
  for build_dir in "$builds"/*/; do
    if [[ "$build_dir" != "$build/" && "$build_dir" != "$newest" && "$build_dir" != "$second_newest" ]]; then
      rm -rf -- "${build_dir%/}"
    fi
  done
fi

root="$HOME/ButlerDemo/mac"
mkdir -p "$root/home" "$root/data" "$root/codex" "$root/electron"
if lsof -nP -iTCP:19765 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "포트 19765 사용 중: 기존 데모를 먼저 종료하세요."; exit 1
fi
cat > "$root/.build-run.sh.new" <<'RUN'
#!/bin/bash
root=$1 app=$2
shift 2
export HOME="$root/home" BUTLER_HOME="$root/home" BUTLER_DATA="$root/data" CODEX_HOME="$root/codex"
export BUTLER_APP_ELECTRON_USER_DATA_DIR="$root/electron"
export BUTLER_APP_SERVER_PORT=19765 BUTLER_APP_SERVER_HOST=127.0.0.1 BUTLER_APP_SERVER_URL=http://127.0.0.1:19765/
export BUTLER_APP_DISABLE_SHELL_REGISTRATION=1
unset BUTLER_CLOUD_API_URL
payload="$app/Contents/Resources/bundled-agent"
export BUTLER_NATIVE_AGENT_EXECUTABLE="$payload/bin/butler-agent"
"$BUTLER_NATIVE_AGENT_EXECUTABLE" --installation-root "$payload" --resource-root "$payload/resources" >>"$root/gateway.log" 2>&1 &
gw=$!
echo $gw > "$root/build-gateway.pid"
for _ in $(seq 1 200); do lsof -nP -iTCP:19765 -sTCP:LISTEN >/dev/null 2>&1 && break; sleep 0.15; done
"$app/Contents/MacOS/Butler" "$@" >>"$root/electron.log" 2>&1 &
echo $! > "$root/build-app.pid"
wait $!
kill -TERM $gw 2>/dev/null; wait $gw 2>/dev/null
RUN
mv -- "$root/.build-run.sh.new" "$root/.build-run.sh"
nohup bash "$root/.build-run.sh" "$root" "$APP" "$@" >/dev/null 2>&1 &
echo "버틀러 테스트 빌드를 띄웁니다. 이 창은 닫아도 됩니다."
