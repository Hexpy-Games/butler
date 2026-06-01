#!/usr/bin/env bash
# Build or consume a Butler service release artifact, then verify that the
# packaged artifact installs and runs inside a disposable Docker container.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${BUTLER_RELEASE_DOCKER_IMAGE:-ubuntu:24.04}"
ARTIFACT_PATH="${1:-}"
GENERATED_DIR=""

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to verify a release artifact." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is not running. Start Docker Desktop and retry." >&2
  exit 1
fi

if [[ -z "$ARTIFACT_PATH" ]]; then
  GENERATED_DIR="$REPO_ROOT/.tmp/service-release-docker"
  rm -rf "$GENERATED_DIR"
  mkdir -p "$GENERATED_DIR"
  (cd "$REPO_ROOT" && "${BUTLER_BUN:-bun}" run --silent release:service:package --out "$GENERATED_DIR")
  ARTIFACT_PATH="$(find "$GENERATED_DIR" -maxdepth 1 -name 'butler-service-*-all.tar.gz' -print | sort | tail -n 1)"
fi

if [[ -z "$ARTIFACT_PATH" || ! -f "$ARTIFACT_PATH" ]]; then
  echo "service release artifact not found: ${ARTIFACT_PATH:-<empty>}" >&2
  exit 1
fi

ARTIFACT_DIR="$(cd "$(dirname "$ARTIFACT_PATH")" && pwd)"
ARTIFACT_NAME="$(basename "$ARTIFACT_PATH")"
ARTIFACT_PATH="$ARTIFACT_DIR/$ARTIFACT_NAME"

docker run --rm \
  -v "$ARTIFACT_DIR:/release:ro" \
  -e BUTLER_INSTALL_IN_DOCKER=1 \
  -e BUTLER_ACCEPT_EXPERIMENTAL=1 \
  -e NO_COLOR=1 \
  "$IMAGE" \
  bash -lc '
    set -euo pipefail

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
        echo "No supported package manager found." >&2
        exit 1
      fi
    }

    install_container_dependencies

    export BUTLER_HOME=/opt/butler
    export BUTLER_DATA=/tmp/butler-data
    mkdir -p "$BUTLER_HOME" "$BUTLER_DATA"
    tar -xzf "/release/'"$ARTIFACT_NAME"'" -C "$BUTLER_HOME"
    app_web_client="$BUTLER_HOME/packages/butler-agent/resources/app-client/dist"
    if [[ ! -f "$app_web_client/index.html" ]]; then
      echo "Service release artifact is missing the built Butler app web client: $app_web_client" >&2
      exit 1
    fi
    cd "$BUTLER_HOME"

    ./install.sh \
      --non-interactive \
      --home "$BUTLER_HOME" \
      --data "$BUTLER_DATA" \
      --gateway app \
      --no-register-service

    for attempt in $(seq 1 45); do
      if curl -fsS http://127.0.0.1:18765/health >/tmp/butler-health.json; then
        grep -q "\"ok\":true" /tmp/butler-health.json
        echo "service-release-docker-health-ok"
        cat /tmp/butler-health.json
        curl -fsS -D /tmp/butler-root.headers -o /tmp/butler-root.html http://127.0.0.1:18765/
        grep -qi "content-type: text/html" /tmp/butler-root.headers
        grep -qi "<title>Butler</title>" /tmp/butler-root.html
        echo "service-release-docker-web-ok"
        BUTLER_HOME="$BUTLER_HOME" BUTLER_DATA="$BUTLER_DATA" \
          "$BUTLER_HOME/packages/butler-agent/scripts/service-control.sh" stop >/dev/null 2>&1 || true
        exit 0
      fi
      sleep 2
    done

    echo "Butler app gateway health check did not become ready." >&2
    find "$BUTLER_DATA/logs" -maxdepth 1 -type f -print -exec tail -n 80 {} \; 2>/dev/null || true
    BUTLER_HOME="$BUTLER_HOME" BUTLER_DATA="$BUTLER_DATA" \
      "$BUTLER_HOME/packages/butler-agent/scripts/service-control.sh" stop >/dev/null 2>&1 || true
    exit 1
  '
