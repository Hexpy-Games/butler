# Project Ledger publication memory evidence

This runner measures the reviewed production path
`applyProjectLedgerRecordUpdates` in one long-lived process:

```text
warmup 1 -> steady 1 -> steady 2 -> steady 3 -> steady 4 -> steady 5 -> steady 6
```

Run it against a disposable large Ledger clone, not the canonical operator
Ledger. The clone must contain at least 3,000 source records and 100 MiB of
authoritative bytes. Choose an existing record that is safe to update; the
runner changes only its bounded `reason` field per cycle.

```bash
bun tests/support/project-ledger-publication-memory-cli.ts \
  --ledger-root <cloned-ledger-root> \
  --butler-data <private-runtime-data-root> \
  --record-id <existing-record-id> \
  --record-kind <work|task|attempt|reference> \
  --steady-cycles 6 \
  --output <privacy-safe-report.json>
```

The report contains corpus counts, cycle duration, internal RSS/heap counters,
and the platform-specific external source. The CLI runs a parent observer
against a separate long-lived child worker; the parent samples the child every
250ms and retains the peak for each phase, so a transient publication spike is
not replaced by the after-only sample:

- macOS: physical footprint plus RSS;
- Linux: private resident plus RSS;
- Windows: `WorkingSet64` plus `PrivateMemorySize64` plus RSS when available.

The gate is fail-closed. It requires at least six steady cycles, keeps every
platform-specific sample below 768 MiB, compares the median of steady samples
1-3 with the median of the final three samples (allowing at most 10% growth),
and rejects strictly positive monotonic growth across the full steady series.
On Windows, both `WorkingSet64` and `PrivateMemorySize64` must satisfy the
768 MiB budget. A missing platform counter or a platform without a supported
source is `unavailable`, never `pass`. Exit codes are `0=pass`, `1=fail`, and
`3=unavailable`.

The standard evidence contract is one warmup plus six steady cycles. Values
below six are normalized to the six-cycle minimum; a pure gate evaluation with
only three steady cycles is `unavailable` with `steady_cycles_incomplete` and
must not be used as acceptance evidence. `--steady-cycles 6` through `12`
preserves the requested post-warmup samples in the same report.

Reports contain no Ledger path, record id, record body, process id, command
line, credential, or raw tool data. Keep the clone and report local.
