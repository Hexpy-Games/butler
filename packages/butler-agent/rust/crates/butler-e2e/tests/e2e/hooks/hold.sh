#!/bin/sh
# Signal that the hold hook started, then wait for release.
# The wait ends within the hook's 60 s timeout even if no release ever comes.
cat > /dev/null
: > "$HOOK_HELD"
deadline=$(($(date +%s) + 60))
while [ ! -f "$HOOK_RELEASE" ]; do
    [ "$(date +%s)" -lt "$deadline" ] || exit 1
    sleep 0.02
done
printf '%s' "$HOOK_TEXT"
