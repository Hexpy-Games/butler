#!/usr/bin/env bash
# Run the Butler installer interactively in a disposable Docker container.
# This never mounts the host Butler data directory and never runs install.sh
# against the host checkout directly.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${BUTLER_INSTALL_DOCKER_IMAGE:-ubuntu:24.04}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to run this installer sandbox." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is not running. Start Docker Desktop and retry." >&2
  exit 1
fi

exec docker run --rm -it \
  -v "$REPO_ROOT":/src:ro \
  -w /tmp \
  -e FORCE_COLOR="${FORCE_COLOR:-1}" \
  -e BUTLER_INSTALL_IN_DOCKER=1 \
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
        echo "No supported package manager found; continuing with image defaults." >&2
      fi
    }

    install_container_dependencies

    mkdir -p /tmp/butler-install-home
    tar -C /src \
      --exclude=.git \
      --exclude=node_modules \
      --exclude="*/node_modules" \
      --exclude=.butler \
      --exclude=.DS_Store \
      -cf - . | tar -C /tmp/butler-install-home -xf -
    cd /tmp/butler-install-home
    exec ./install.sh \
      --home /tmp/butler-install-home \
      --data /tmp/butler-install-data
  '
