#!/bin/zsh
# Fetches the patched gpui-ce fork the crate builds against. CEF itself downloads into $CEF_PATH on first build.
set -eu
root=${0:A:h:h}
if [ ! -d "$root/gpui-fork" ]; then
  git clone -q https://github.com/Hexpy-Games/gpui-ce "$root/gpui-fork"
  git -C "$root/gpui-fork" checkout -q e5cdb0cbd84ef109c08f4a594555fd733ba7b16a
  git -C "$root/gpui-fork" apply "$root/gpui-fork.patch"
fi
