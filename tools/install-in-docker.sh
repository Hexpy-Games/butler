#!/usr/bin/env bash
# Build or consume a Butler Agent release artifact, then run install.sh
# interactively inside a disposable Docker container.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${BUTLER_INSTALL_DOCKER_IMAGE:-ubuntu:24.04}"
ARTIFACT_PATH="${BUTLER_INSTALL_DOCKER_ARTIFACT:-}"
GENERATED_DIR=""
HOST_APP_PORT="${BUTLER_INSTALL_DOCKER_HOST_PORT:-}"
CONTAINER_APP_PORT="${BUTLER_INSTALL_DOCKER_APP_PORT:-18765}"

validate_port() {
  local name="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[0-9]+$ ]] || (( value < 1 || value > 65535 )); then
    echo "$name must be a TCP port between 1 and 65535; got: $value" >&2
    exit 1
  fi
}

validate_port BUTLER_INSTALL_DOCKER_APP_PORT "$CONTAINER_APP_PORT"

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

if [[ -n "$HOST_APP_PORT" ]]; then
  validate_port BUTLER_INSTALL_DOCKER_HOST_PORT "$HOST_APP_PORT"
  if host_port_in_use "$HOST_APP_PORT"; then
    echo "BUTLER_INSTALL_DOCKER_HOST_PORT is already in use on 127.0.0.1: $HOST_APP_PORT" >&2
    exit 1
  fi
else
  for candidate in $(seq 18766 18865); do
    if ! host_port_in_use "$candidate"; then
      HOST_APP_PORT="$candidate"
      break
    fi
  done
  if [[ -z "$HOST_APP_PORT" ]]; then
    echo "No free host port found in 18766-18865 for the Docker app server." >&2
    echo "Set BUTLER_INSTALL_DOCKER_HOST_PORT to an available port and retry." >&2
    exit 1
  fi
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to run this installer sandbox." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is not running. Start Docker Desktop and retry." >&2
  exit 1
fi

if [[ -z "$ARTIFACT_PATH" ]]; then
  GENERATED_DIR="$REPO_ROOT/.tmp/interactive-install-docker"
  rm -rf "$GENERATED_DIR"
  mkdir -p "$GENERATED_DIR"
  (cd "$REPO_ROOT" && "${BUTLER_BUN:-bun}" run --silent release:agent:package --out "$GENERATED_DIR")
  ARTIFACT_PATH="$(find "$GENERATED_DIR" -maxdepth 1 -name 'butler-agent-*-all.tar.gz' -print | sort | tail -n 1)"
fi

if [[ -z "$ARTIFACT_PATH" || ! -f "$ARTIFACT_PATH" ]]; then
  echo "Butler Agent release artifact not found: ${ARTIFACT_PATH:-<empty>}" >&2
  exit 1
fi

ARTIFACT_DIR="$(cd "$(dirname "$ARTIFACT_PATH")" && pwd)"
ARTIFACT_NAME="$(basename "$ARTIFACT_PATH")"
ARTIFACT_PATH="$ARTIFACT_DIR/$ARTIFACT_NAME"

echo "Butler Agent release artifact: $ARTIFACT_PATH"
echo "Starting interactive Docker installer in $IMAGE"
echo "Publishing Butler app server: http://127.0.0.1:$HOST_APP_PORT -> container port $CONTAINER_APP_PORT"

exec docker run --rm -it \
  -p "127.0.0.1:$HOST_APP_PORT:$CONTAINER_APP_PORT" \
  -v "$ARTIFACT_DIR:/release:ro" \
  -e FORCE_COLOR="${FORCE_COLOR:-1}" \
  -e BUTLER_INSTALL_IN_DOCKER=1 \
  -e BUTLER_INSTALL_HOST_APP_URL="http://127.0.0.1:$HOST_APP_PORT" \
  "$IMAGE" \
  bash -lc '
    set -euo pipefail
    host_app_port="$1"
    shift
    container_app_port="$1"
    shift
    artifact_name="$1"
    shift

    install_container_dependencies() {
      if command -v apt-get >/dev/null 2>&1; then
        export DEBIAN_FRONTEND=noninteractive
        apt-get update
        apt-get install -y --no-install-recommends \
          ca-certificates \
          curl \
          git \
          unzip \
          zip \
          tar \
          gzip \
          xz-utils \
          build-essential \
          python3 \
          pkg-config \
          procps
        rm -rf /var/lib/apt/lists/*
      elif command -v dnf >/dev/null 2>&1; then
        dnf install -y \
          ca-certificates \
          curl \
          git \
          unzip \
          zip \
          tar \
          gzip \
          xz \
          gcc \
          gcc-c++ \
          make \
          python3 \
          pkgconf-pkg-config \
          procps-ng
      elif command -v apk >/dev/null 2>&1; then
        apk add --no-cache \
          ca-certificates \
          curl \
          git \
          unzip \
          zip \
          tar \
          gzip \
          xz \
          build-base \
          python3 \
          pkgconf \
          procps
      else
        echo "No supported package manager found; continuing with image defaults." >&2
      fi
    }

    install_container_dependencies

    export BUTLER_HOME=/opt/butler
    export BUTLER_DATA=/tmp/butler-data
    export PATH="$BUTLER_DATA/bin:$PATH"
    mkdir -p "$BUTLER_HOME" "$BUTLER_DATA"
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
    tar -xzf "/release/$artifact_name" -C "$BUTLER_HOME"
    app_web_client="$BUTLER_HOME/packages/butler-agent/resources/app-client/dist"
    if [[ ! -f "$app_web_client/index.html" ]]; then
      echo "Butler Agent release artifact is missing the built Butler app web client: $app_web_client" >&2
      exit 1
    fi
    cd "$BUTLER_HOME"

    echo
    echo "Release artifact extracted to $BUTLER_HOME"
    echo "Butler data path: $BUTLER_DATA"
    echo "Butler app web client: $app_web_client"
    echo "Container app server bind: 0.0.0.0:$container_app_port"
    echo "Host web URL: http://127.0.0.1:$host_app_port"
    echo "Host health URL: http://127.0.0.1:$host_app_port/health"
    echo "Launching interactive install.sh"
    echo

    set +e
    ./install.sh \
      --home "$BUTLER_HOME" \
      --data "$BUTLER_DATA" \
      "$@"
    install_status=$?
    set -e

    if [[ "$install_status" -eq 130 ]]; then
      exit 130
    fi

    echo
    if [[ "$install_status" -eq 0 ]]; then
      echo "Install finished. Docker container is staying open for Butler app-server testing."
      echo "Host web URL: http://127.0.0.1:$host_app_port"
      echo "Host health URL: http://127.0.0.1:$host_app_port/health"
      echo "Container health URL: http://127.0.0.1:$container_app_port/health"
      echo
      health_ok=0
      for attempt in $(seq 1 30); do
        if curl -fsS "http://127.0.0.1:$container_app_port/health" >/tmp/butler-app-health.json; then
          echo "Butler app server health check passed:"
          cat /tmp/butler-app-health.json
          echo
          health_ok=1
          break
        fi
        sleep 1
        if [[ "$attempt" -eq 30 ]]; then
          echo "Butler app server health check did not pass yet; container shell remains open for inspection." >&2
        fi
      done
      if [[ "$health_ok" -eq 1 ]]; then
        if curl -fsS -D /tmp/butler-app-root.headers -o /tmp/butler-app-root.html "http://127.0.0.1:$container_app_port/" &&
          grep -qi "content-type: text/html" /tmp/butler-app-root.headers &&
          grep -qi "<title>Butler</title>" /tmp/butler-app-root.html; then
          echo "Butler app web check passed: / served HTML."
        else
          echo "Butler app web check did not pass yet; container shell remains open for inspection." >&2
        fi
      fi
    else
      echo "Install exited with status $install_status. Docker container is staying open for inspection." >&2
    fi

    echo
    echo "Useful commands inside this shell:"
    echo "  butler status"
    echo "  butler gateway status app --json"
    echo "  curl -fsS http://127.0.0.1:$container_app_port/"
    echo "  curl -fsS http://127.0.0.1:$container_app_port/health"
    echo "  butler logs --service butler-main --lines 100"
    echo
    exec bash -l
  ' butler-install-docker "$HOST_APP_PORT" "$CONTAINER_APP_PORT" "$ARTIFACT_NAME" "$@"
