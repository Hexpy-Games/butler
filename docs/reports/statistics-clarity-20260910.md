# Statistics clarity and period loading

Spec: SPEC-STATISTICS-CLARITY-20260910. Work: W-STATISTICS-CLARITY-20260910.

## Root causes and changes

The previous heatmap described activity counts without naming the counted unit,
paired no swatches with the numeric bands, and omitted most weekday labels and
the month axis. The grid now has all weekday labels and a month axis, and its
legend uses the exact cell styles for 0, 1, 2–4, 5–9, 10+ items and unavailable.
Localized explanation and an example identify distinct active conversations,
changed Work/Task and materials per day, not message counts or completion rate.
Selecting a date still opens the existing count breakdown and source list.

Work/Task controlled three sections from inside the first chart. Flow, current
distribution and aging now share a Work overview Section with the control in its
title row. Child charts no longer imply ownership of a wider filter.

The old 90-day production GET took 41.13s. Its correlated terminal-time subquery
searched the event-type index again for every Turn. Existing databases deliberately
retain JSON identity indexes; older state events have nested IDs and no extracted
column ID. New databases retain prepared column-index lookups, now with the
nonempty predicate required by their partial index. Old databases instead stream
state-event metadata once, newest first, keeping only requested Turn identities
and exact current-state matches. No production migration or index backfill runs.

Statistics request identity previously included every live revision: a revision
could discard the pending result and hide current data behind loading again.
The focused hook now owns project/period/timezone scope, coalesces in-flight
invalidations, retains current-scope data while refreshing and fences old responses.
After 20s without a response it leaves loading and offers explicit retry. Late
bridge responses cannot replace the newer attempt. No automatic retry loop,
new endpoint, provider request, cache authority or extra polling was added.

## Validation and boundaries

- Focused checks: statistics semantics and existing/new schema compatibility;
  deferred, stalled, failed and stale requests; heatmap bands, labels and selection.
- Read-only real-data comparison at the same observed time preserves all 480
  previously counted terminal results and the identical conversation series.
  It also recovers 283 persisted old nested-ID terminal records, reducing excluded
  requests from 319 to 36. Counts are not artificially reduced for performance.
- An isolated HTTP/browser smoke invokes the actual route, dashboard store and
  production component with the production database opened read-only. No schema
  initialization, conversation mutation, model invocation or operating restart.
  First cold 30-day query: 6.06s; 7 days: 2.05s; 90 days: 1.44s; repeated 30 days:
  0.46s. These are observations, not fixed latency guarantees.
- Browser verifies 7/90/30 switching, common heading/control alignment, source
  selection and no document overflow at 1440/430/390/375/320px, plus dark mode.
  Screenshots and timings stay under /tmp/statistics-clarity (not committed).
- DS render/build runs, but its element-crop images remain blank as in the prior
  density slice; direct production-component browser screenshots are the visual
  evidence. The broad legacy design suite retains its same 12 baseline failures.

Implementation and source-level validation are separate from operational rollout.
The running server and packaged Electron app have not been restarted in this slice.
