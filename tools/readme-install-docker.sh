#!/usr/bin/env bash
# Start a dependency-only Docker sandbox for manually following README install steps.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(tr -d '[:space:]' < "$REPO_ROOT/VERSION")"
RELEASE_TAG="${BUTLER_README_DOCKER_TAG:-v$VERSION}"
IMAGE="${BUTLER_README_DOCKER_IMAGE:-butler-install-deps:ubuntu-24.04}"
CONTAINER_NAME="${BUTLER_README_DOCKER_CONTAINER:-butler-readme-install}"
DOCKERFILE="$REPO_ROOT/tools/docker/install-deps.Dockerfile"
ARTIFACT_PATH="${BUTLER_README_DOCKER_ARTIFACT:-${1:-}}"
GENERATED_DIR="$REPO_ROOT/.tmp/readme-install-docker/$RELEASE_TAG"
HOST_APP_PORT="${BUTLER_README_DOCKER_HOST_PORT:-}"
CONTAINER_APP_PORT="${BUTLER_README_DOCKER_APP_PORT:-18765}"

validate_port() {
  local name="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[0-9]+$ ]] || (( value < 1 || value > 65535 )); then
    echo "$name must be a TCP port between 1 and 65535; got: $value" >&2
    exit 1
  fi
}

host_port_in_use() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    return 0
  fi
  if command -v nc >/dev/null 2>&1 && nc -z 127.0.0.1 "$port" >/dev/null 2>&1; then
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$port" <<'PY'
import socket
import sys

port = int(sys.argv[1])
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
try:
    sock.bind(("127.0.0.1", port))
except OSError:
    sys.exit(0)
finally:
    sock.close()
sys.exit(1)
PY
    return $?
  fi
  return 1
}

select_host_port() {
  if [[ -n "$HOST_APP_PORT" ]]; then
    validate_port BUTLER_README_DOCKER_HOST_PORT "$HOST_APP_PORT"
    if host_port_in_use "$HOST_APP_PORT"; then
      echo "BUTLER_README_DOCKER_HOST_PORT is already in use on 127.0.0.1: $HOST_APP_PORT" >&2
      exit 1
    fi
    return
  fi

  for candidate in $(seq 18766 18865); do
    if ! host_port_in_use "$candidate"; then
      HOST_APP_PORT="$candidate"
      return
    fi
  done

  echo "No free host port found in 18766-18865 for the Docker app server." >&2
  echo "Set BUTLER_README_DOCKER_HOST_PORT to an available port and retry." >&2
  exit 1
}

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "docker is required to run the README install sandbox." >&2
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    echo "Docker daemon is not running. Start Docker Desktop and retry." >&2
    exit 1
  fi
}

build_dependency_image() {
  if [[ "${BUTLER_README_DOCKER_BUILD_IMAGE:-1}" != "1" ]] &&
    docker image inspect "$IMAGE" >/dev/null 2>&1; then
    return
  fi

  echo "Building dependency-only Docker image: $IMAGE"
  docker build -t "$IMAGE" -f "$DOCKERFILE" "$REPO_ROOT/tools/docker"
}

verify_checksum() {
  local artifact_dir="$1"
  local sha_file="$2"
  local artifact_name="$3"

  if command -v shasum >/dev/null 2>&1; then
    (cd "$artifact_dir" && shasum -a 256 -c "$(basename "$sha_file")")
    return
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$artifact_dir" && sha256sum -c "$(basename "$sha_file")")
    return
  fi
  python3 - "$artifact_dir/$artifact_name" "$sha_file" <<'PY'
import hashlib
import pathlib
import sys

artifact = pathlib.Path(sys.argv[1])
sha_file = pathlib.Path(sys.argv[2])
expected = sha_file.read_text(encoding="utf-8").split()[0]
actual = hashlib.sha256(artifact.read_bytes()).hexdigest()
if actual != expected:
    print(f"checksum mismatch: expected {expected}, got {actual}", file=sys.stderr)
    sys.exit(1)
print(f"{artifact.name}: OK")
PY
}

download_release_artifact() {
  local version="${RELEASE_TAG#v}"
  local artifact_name="butler-service-$version-all.tar.gz"
  local release_url="https://github.com/Hexpy-Games/butler/releases/download/$RELEASE_TAG"

  mkdir -p "$GENERATED_DIR"
  ARTIFACT_PATH="$GENERATED_DIR/$artifact_name"
  local sha_path="$ARTIFACT_PATH.sha256"

  if [[ ! -f "$ARTIFACT_PATH" ]]; then
    echo "Downloading $RELEASE_TAG Butler Agent artifact"
    curl -fL --retry 3 -o "$ARTIFACT_PATH" "$release_url/$artifact_name"
  fi
  if [[ ! -f "$sha_path" ]]; then
    curl -fL --retry 3 -o "$sha_path" "$release_url/$artifact_name.sha256"
  fi

  verify_checksum "$GENERATED_DIR" "$sha_path" "$artifact_name"
}

prepare_artifact() {
  if [[ -z "$ARTIFACT_PATH" ]]; then
    download_release_artifact
  fi
  if [[ -z "$ARTIFACT_PATH" || ! -f "$ARTIFACT_PATH" ]]; then
    echo "Butler Agent release artifact not found: ${ARTIFACT_PATH:-<empty>}" >&2
    exit 1
  fi
}

start_container() {
  local artifact_dir artifact_name
  artifact_dir="$(cd "$(dirname "$ARTIFACT_PATH")" && pwd)"
  artifact_name="$(basename "$ARTIFACT_PATH")"

  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker run -d \
    --name "$CONTAINER_NAME" \
    -p "127.0.0.1:$HOST_APP_PORT:$CONTAINER_APP_PORT" \
    -v "$artifact_dir:/home/butler/Downloads:ro" \
    -e BUTLER_INSTALL_IN_DOCKER=1 \
    -e BUTLER_INSTALL_HOST_APP_URL="http://127.0.0.1:$HOST_APP_PORT" \
    -e FORCE_COLOR="${FORCE_COLOR:-1}" \
    -e BUTLER_HOME=/home/butler/butler \
    -e BUTLER_DATA=/home/butler/.butler \
    "$IMAGE" \
    bash -lc '
      set -euo pipefail
      host_app_port="$1"
      container_app_port="$2"
      artifact_name="$3"

      mkdir -p "$BUTLER_DATA/gateways"
      cat > "$BUTLER_DATA/gateways/app.json" <<EOF
{
  "id": "app",
  "enabled": true,
  "config": {
    "host": "0.0.0.0",
    "port": $container_app_port
  },
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

      if ! grep -q "BUTLER_DATA/bin" "$HOME/.bashrc" 2>/dev/null; then
        cat >> "$HOME/.bashrc" <<'"'"'EOF'"'"'

export BUTLER_INSTALL_IN_DOCKER=1
export BUTLER_HOME="$HOME/butler"
export BUTLER_DATA="$HOME/.butler"
export PATH="$BUTLER_DATA/bin:$PATH"
EOF
      fi

      cat > "$HOME/README-INSTALL-COMMANDS.txt" <<EOF
README install commands:

mkdir -p ~/butler
tar -xzf ~/Downloads/butler-service-*-all.tar.gz -C ~/butler
cd ~/butler
./install.sh

After install:

butler status
butler gateway status app --json
curl -fsS http://127.0.0.1:$container_app_port/health
curl -fsS http://127.0.0.1:$container_app_port/

Host browser:

http://127.0.0.1:$host_app_port
http://127.0.0.1:$host_app_port/health

Mounted artifact:

~/Downloads/$artifact_name
EOF

      echo "Butler README install sandbox is ready."
      echo "Commands are in ~/README-INSTALL-COMMANDS.txt"
      tail -f /dev/null
    ' butler-readme-docker "$HOST_APP_PORT" "$CONTAINER_APP_PORT" "$artifact_name" >/dev/null

  echo "Dependency-only Docker image: $IMAGE"
  echo "Container: $CONTAINER_NAME"
  echo "Mounted artifact: $artifact_dir/$artifact_name -> /home/butler/Downloads/$artifact_name"
  echo "Host web URL after install: http://127.0.0.1:$HOST_APP_PORT"
  echo "Host health URL after install: http://127.0.0.1:$HOST_APP_PORT/health"
  echo
  echo "Connect with:"
  echo "  docker exec -it $CONTAINER_NAME bash -l"
  echo
  echo "Then follow README commands:"
  echo "  mkdir -p ~/butler"
  echo "  tar -xzf ~/Downloads/butler-service-*-all.tar.gz -C ~/butler"
  echo "  cd ~/butler"
  echo "  ./install.sh"
}

validate_port BUTLER_README_DOCKER_APP_PORT "$CONTAINER_APP_PORT"
select_host_port
require_docker
build_dependency_image
prepare_artifact
start_container

if [[ "${BUTLER_README_DOCKER_ATTACH:-1}" == "1" && -t 0 && -t 1 ]]; then
  exec docker exec -it "$CONTAINER_NAME" bash -l
fi
