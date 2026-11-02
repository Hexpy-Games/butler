#!/bin/sh
if [ -n "$HOOK_FILE" ]; then
    cat "$HOOK_FILE"
else
    printf '%s' "$HOOK_TEXT"
fi
if [ -n "$HOOK_FAIL_ONCE" ]; then
    if [ -f "$HOOK_FAIL_ONCE" ]; then exit 0; fi
    : > "$HOOK_FAIL_ONCE"
fi
exit "${HOOK_EXIT:-0}"
