#!/bin/sh
# Parent reaps children on TERM; the grandchild would otherwise live for a minute.
trap 'wait; exit 0' TERM
sh -c 'trap "wait; exit 0" TERM; sleep 60 & echo $! >> "$HOOK_PIDS"; wait' &
echo $! >> "$HOOK_PIDS"
wait
