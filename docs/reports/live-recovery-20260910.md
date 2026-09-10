# Live recovery and composer feedback

Spec: `SPEC-LIVE-RECOVERY-20260910`; Work: `W-LIVE-RECOVERY-20260910`.

## Causes and changes

- Replaced subscriptions shared unrestricted callbacks. A late error could mark
  a newer healthy connection lost; a late open/event could falsely mark it healthy.
  `liveEventConnection` now owns a generation fence, cancellation and bounded
  backoff. The existing hook delegates lifetime only; event projection and
  canonical navigation/session reconciliation remain with their existing owners.
- Idle SSE responses had no initial flush and first emitted a comment heartbeat
  after 15 seconds. Browser EventSource could not observe those comments. The
  server now immediately emits a named heartbeat after replay, then every 15s.
  Heartbeats have no durable cursor and are not applied as timeline events.
  Browser and Electron preload deliver them as explicit health signals.
- Pending opens time out after 30s; heartbeat-enabled streams retry after 45s
  without any signal. Offline closes the stream, online wakes retry, and stale
  visible resume replaces the stream. Timers alone never declare recovery.
  Canonical views reconcile after recovery, not each failed connection attempt.
- The composer previously had no live-connection gate. Its common toolbar now
  directly selects connection loss and shows a disabled busy control in the same
  rightmost slot, including compact mode. The full-width banner becomes a
  screen-reader-only status. Labels use central Korean/English copy.
- Enter/form submit and the store send entrypoint reject new sends while lost.
  Draft text and attachments are not cleared, and recovery does not auto-send.

## Review and rollout boundaries

One lifecycle owns transport health; no second store or polling fetch was added.
The gate applies to the shared conversation/dashboard/worker composer. Existing
send/stop rules return on recovery. Running work is not cancelled or replayed.
Spinner contrast, 16px/20px sizing and reduced motion remain DS-owned.

For rolling updates, heartbeat silence is enforced only after an observable
heartbeat was received. Older server/preload combinations retain open/error
recovery without false heartbeat timeouts. Full liveness detection requires the
updated server and, for Electron, the updated preload on next app launch.
The named heartbeat carries JSON null so older preload readers skip it instead
of projecting an empty object into timeline state during a server-first update.
This change does not guarantee that an unavailable network/server becomes available.

## Evidence

Focused hook tests cover stale callbacks, repeated loss, open without messages,
heartbeat silence, offline/online, stale resume, disposal and cursor preservation.
Transport tests exercise the actual SSE response, browser EventSource adapter,
and actual Electron preload (fragmented records and reader cleanup).
Composer tests verify disabled/busy recovery and draft/submit guards.
All 34 focused tests pass (23 lifecycle/reconciliation, 8 transport/backoff,
3 composer). Repository and UI typechecks pass. Lint has no errors (238 existing
warnings). The production UI build and five-viewport ComposerCard render pass.

`tests/smoke/live-recovery-browser.ts` connects the actual response implementation
through native browser EventSource, the production connection hook, toolbar and
submit hook in an isolated preview. It aborts the stream, temporarily returns
503, restores service without a conversation event, and verifies recovery,
disabled sending, Enter blocking and unchanged draft at 1280/430/390/375/320px.
Screenshots: `/tmp/live-recovery-browser/`.

No operating server or Electron app was restarted for this check. Native network
transport is tested through the preload harness, not a restarted packaged app.
The broad legacy design suite's known source-shape failures remain outside this
change; they are not described as a passing gate.
