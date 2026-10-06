#!/bin/sh
cat >> "$HOOK_OUTPUT"
printf '\n' >> "$HOOK_OUTPUT"
if [ "$BUTLER_HOOK_EVENT" = Stop ] && [ -n "$HOOK_STOP_ONCE" ] && [ ! -f "$HOOK_STOP_ONCE" ]; then
    : > "$HOOK_STOP_ONCE"
    printf '{"decision":"deny","reason":"Continue once"}'
fi
