#!/bin/zsh
# Fetches the patched gpui-ce fork the crate builds against. CEF itself downloads into $CEF_PATH on first build.
set -eu
root=${0:A:h:h}
if [ ! -d "$root/gpui-fork" ]; then
  git clone -q https://github.com/Hexpy-Games/gpui-ce "$root/gpui-fork"
  git -C "$root/gpui-fork" checkout -q d15253366449d5931f6bae9c95190198fd7c23e2
  git -C "$root/gpui-fork" apply "$root/gpui-fork.patch"
fi
