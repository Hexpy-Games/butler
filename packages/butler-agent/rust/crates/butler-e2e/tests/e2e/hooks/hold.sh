#!/bin/sh
# Signal that the tool result reached its post-tool hook, then wait for release.
cat > /dev/null
: > "$HOOK_HELD"
while [ ! -f "$HOOK_RELEASE" ]; do sleep 0.02; done
