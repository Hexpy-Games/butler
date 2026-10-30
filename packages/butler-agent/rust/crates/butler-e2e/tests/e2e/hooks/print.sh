#!/bin/sh
if [ -n "$HOOK_FILE" ]; then
    cat "$HOOK_FILE"
else
    printf '%s' "$HOOK_TEXT"
fi
exit "${HOOK_EXIT:-0}"
