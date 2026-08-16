# Guided command process lifecycle

`run_command` enters this module through the production Guided Turn tool
boundary. This module owns the spawned command process until it exits or the
existing command timeout or Turn cancellation requests termination.

## Contract

- A command may run for its full configured `timeout_ms`. This module does not
  shorten, reinterpret, or infer a timeout from perceived progress.
- Normal command exit preserves the existing exit code, output spool, and
  descendant cleanup behavior.
- Timeout and cancellation are termination decisions, not performance
  judgments. The first decision is retained if timeout and cancellation race.
  Once either occurs, the owned process group receives graceful termination,
  then forced termination after a short cleanup grace if it has not closed.
- Graceful and forced termination are each attempted at most once. A signal
  delivery failure settles as a typed command failure instead of leaving the
  Turn pending.
- A process that ignores both signals cannot retain the Turn indefinitely. The
  command promise settles after a bounded post-kill drain window.
- Timeout produces the existing `timedOut` command result. Cancellation rejects
  with the caller's cancellation reason. Neither path retries or respawns the
  command.

## Scope

This lifecycle is independent of browser or page-preview behavior. It does not
add browser tools, require visual inspection, or change Work completion policy.
POSIX hosts terminate the full owned process
group; other host adapters retain their existing platform containment boundary.

## Acceptance

1. A POSIX command group that ignores `SIGTERM` is force-terminated and the
   command settles as timed out without leaving its descendant alive.
2. Turn cancellation uses the same bounded cleanup and returns cancellation,
   not a successful command result. A later timeout cannot overwrite it, and a
   later cancellation cannot overwrite an earlier timeout.
3. A command that exits normally before its configured timeout is not signaled
   and retains its output and exit code.
4. The real Guided Turn command entrypoint uses this lifecycle; no test-only
   runner substitutes for it.
