FROM ubuntu:24.04

ARG BUTLER_UID=10001
ARG BUTLER_GID=10001

ENV DEBIAN_FRONTEND=noninteractive
ENV TERM=xterm-256color

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    curl \
    git \
    gzip \
    less \
    lsof \
    nano \
    netcat-openbsd \
    pkg-config \
    procps \
    python3 \
    sudo \
    tar \
    unzip \
    vim-tiny \
    xz-utils \
    zip \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid "${BUTLER_GID}" butler \
  && useradd --uid "${BUTLER_UID}" --gid "${BUTLER_GID}" --create-home --shell /bin/bash butler \
  && printf 'butler ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/butler \
  && chmod 0440 /etc/sudoers.d/butler

USER butler
WORKDIR /home/butler

RUN mkdir -p /home/butler/Downloads /home/butler/.butler/gateways
