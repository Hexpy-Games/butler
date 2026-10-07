# Owner Windows quality gates; native stderr never decides command success.
$ErrorActionPreference = 'Stop'
$ErrorActionPreference = 'Continue'
python "$env:GITHUB_WORKSPACE/.github/scripts/isolated.py" python -c "import sys; print('successful native stderr', file=sys.stderr)" 2>&1 | Out-Host
$ErrorActionPreference = 'Stop'
if ($LASTEXITCODE -ne 0) { throw 'Successful native stderr changed the exit code' }
$ErrorActionPreference = 'Continue'
python "$env:GITHUB_WORKSPACE/.github/scripts/isolated.py" python -c "import sys; print('failed native stderr', file=sys.stderr); sys.exit(7)" 2>&1 | Out-Host
$ErrorActionPreference = 'Stop'
if ($LASTEXITCODE -ne 7) { throw 'Failed native stderr lost the exit code' }
$global:LASTEXITCODE = 0
$root = $env:OWNER_JOB_ROOT
$env:PREVIEW_ROOT = $root
New-Item -ItemType Directory -Force "$root/logs" | Out-Null
# Keep toolchain/cache locations while every check gets a fresh HOME.
"CARGO_HOME=$env:USERPROFILE/.cargo" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
"RUSTUP_HOME=$env:USERPROFILE/.rustup" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
"PREVIEW_ROOT=$root" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
$ErrorActionPreference = 'Continue'
python "$env:GITHUB_WORKSPACE/.github/scripts/cargo-artifact-cache.py" restore windows-x64 static-ort dev
$ErrorActionPreference = 'Stop'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$env:HOME = Join-Path $env:PREVIEW_ROOT ([guid]::NewGuid())
$env:BUTLER_DATA = Join-Path $env:PREVIEW_ROOT ([guid]::NewGuid())
New-Item -ItemType Directory $env:HOME,$env:BUTLER_DATA | Out-Null
$ErrorActionPreference = 'Continue'
cargo fmt --all -- --check
$ErrorActionPreference = 'Stop'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$env:HOME = Join-Path $env:PREVIEW_ROOT ([guid]::NewGuid())
$env:BUTLER_DATA = Join-Path $env:PREVIEW_ROOT ([guid]::NewGuid())
New-Item -ItemType Directory $env:HOME,$env:BUTLER_DATA | Out-Null
$ErrorActionPreference = 'Continue'
cargo clippy --locked --target x86_64-pc-windows-msvc -p butler-platform -p butler-host -p butler-agent -p butler-e2e --tests -- -D warnings
$ErrorActionPreference = 'Stop'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$env:HOME = Join-Path $env:PREVIEW_ROOT ([guid]::NewGuid())
$env:BUTLER_DATA = Join-Path $env:PREVIEW_ROOT ([guid]::NewGuid())
New-Item -ItemType Directory $env:HOME,$env:BUTLER_DATA | Out-Null
$ErrorActionPreference = 'Continue'
cargo run --locked -p butler-source-check -- .
$ErrorActionPreference = 'Stop'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
