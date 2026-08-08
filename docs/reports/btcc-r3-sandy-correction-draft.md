# BTCC R3 Sandy Turn-Work correction (redacted rehearsal report)

Status: implementation and completed v2 copied-database rehearsal only. The live Sandy database was not mutated or stopped.
Any pre-v2 rehearsal is superseded by the canonical Plan/checkpoint and owner-manifest gates; its hashes must not be used for a live apply.

## Audited target and evidence

- Session: `butler/app-project-bdc1ab45-3cff-401f-9b2e-98a991aa234d`.
- Existing Work: `guided-work-9e114e913e87156179c750e745add710efaf2f636a28a2216615d5dbf5446145`.
- Valid monitoring Turns: `turn-e03778e9-2cd6-4d04-b062-2b8202284d23`, `turn-5390e98a-2a08-4d77-b075-27921725c585`.
- Capture Turns: `turn-a784a700-8d7b-42b8-80ae-e31f193601d3`, `turn-e6b9910c-ff0a-4e84-8630-e0bcbf86c859`.
- Read-only baseline: 4 current bindings, 309 Work results; 128 monitoring results and 181 capture results. The selected raw tool journal contains 317 rows (tool rows are not one-to-one with Work result refs) and is unchanged by correction.
- Source effects were all `applied`; no pending/uncertain effect was eligible for completion.
- The source Plan is locked to revision `guided-plan-e69cd114943a7ee36c8f450aa054191bad64aa422e2f4b510fd6db018aba3211` and the four live action keys: `현재 구현과 운영 기준선 확정`, `관계 정책과 행동 강제 패치`, `검증 후 운영 배포`, `수정 전후 모니터링 비교`. The source checkpoint's first three actions are `done` and monitoring comparison is `active`; the correction appends a validation closeout checkpoint with all four `done`, result sequence 128, and the same Plan revision.
- Sandy checkout evidence: the first capture patch is committed as `a83f3e3` with the observed test/deploy claim; the follow-up has an uncommitted diff and its model-exhaustion final is contaminated fallback, not completion evidence.

## Fresh v2 copied-live rehearsal

The untouched live DB was read-only backed up with SQLite `VACUUM INTO` to `/tmp/butler-sandy-v2.R13GaE/source.sqlite`; no source write or owner stop occurred. All pre-v2 copies and hashes are superseded and must not be used.

The v2 dry-run target digests (before any correction) were:

```text
database identity: 8e9dfacebbc40c585993c611f44d6afc5726aaf6deb43b44af192a9211efa023
before snapshot:   2520da2c3d6f6a911ce41f01260fa9e8b7766861fab3854055d571f4390744ff
binding digest:    51089e37652fa9d21a0c3de87bfbcaec28b44685cc4555d8f54b1de5a2628117
result digest:     f23a43d71bf67c60c9fb5d98be33c82910869b44c18d34b9a51c1da79fdb8a11
selected journal:  317 rows, b8440700aa9505fb06231143a781a8d47b46a221fbfcdfde94c931a47de4988d
observed:          bindings=4 results=309 monitoring=128 capture=181
```

For the canonical composition-order rehearsal, a new copy `/tmp/butler-sandy-v2.R13GaE/canonical.sqlite` was made from the independent pre-apply snapshot. Correction applied with operator `operator-rehearsal-v2`, reason `Canonical composition order rehearsal`, and request fingerprint `1d136bbbe0ad784101e028a64a15a64da0865e3a40b64d8d917034bd53311c54`. The source became `completed`; deterministic capture Work `guided-work-d41316b67c814e5e29e7ab4ea00879a257eb47513e029efed25ad6e0eedf4432` remained `open`; session head moved to capture; bindings/results are 2+2 and 128+181 with contiguous sequences. The source closeout is checkpoint revision 10, validation stage, result sequence 128, all four live action keys `done`, and the fourth note explicitly records the 57-sample/16.5-hour gate (the stale 0-sample note is not carried forward). The capture Work's first gate action is `done`, hardening action is `active`, result sequence is 181, and the contaminated follow-up final is excluded.

The canonical `openBtccSqliteStores` composition was then opened on the applied copy. Its migration added only the copy's missing nullable result provenance columns; a new process closed and reopened the stores, and `durableWork.boundWorkForTurn` returned the following product views: monitoring `completed`, validation checkpoint rev10, all four actions done, disposition completed/result sequence 128/128 refs; capture `open`, execution checkpoint, hardening active, result sequence 181/181 refs. This is the product-reader evidence, not a raw-SQL-only assertion.

Backup receipt from the copied apply:

```text
bundle identity: a3b51367f701afb5dee0080b1ee21fb2a7d95dcfc64545506257fcaa1b778ad1
independent SQLite snapshot: 16b0f53a026471e8c590a6b15d61c3a2e291c2de888f5abef548d844aceac77c
after snapshot: b58ec4d0ecedd6b8c6a9fbcca8af2c24e9e2522387331ebdacdc867f55a88cb0
audit: one immutable receipt; integrity_check: ok
```

A separate process replayed the exact operator/recipe request after migration and returned `already_applied` with the same audit ID/fingerprint and no writes. The replay path authenticates the immutable audit, manifest hash, after-snapshot hash and current semantic postconditions; it does not require the pre-apply DB hash after restart. A tampered operator reason or capture after-state falls through to refusal. No live owner was stopped or touched; owner-running/expired-manifest behavior remains a read-only code-path guard and was not simulated against the live path.

Unrelated semantic rows were unchanged across correction and migration: 40 non-target Work rows hash `0e628eba1fef49e0b1a738ec40ab3232c0654e9000512fb10d607665c8521620`, 48 non-target bindings hash `997b767b7bc0aba9f0d4222d0732be88e9805d3398fd632b77de4043ef441c6a`, and 2,798 non-target result rows hash `e5a5d8ffc9d144d8fb351fdde33fe74329a5d31b7aeea7f3b8d56e1fc0345cfc`. The unrelated Work `guided-work-8981e0721b00f7ea5ebf0fb72bd6e5e20313dc744aba934a0d2e982824655a27` retained hash `df70d74fab70aef23b1655e10912f64a056dabbc360c3cdc550664c29dec1aae`. Selected journal rows remained 317 with digest `b8440700aa9505fb06231143a781a8d47b46a221fbfcdfde94c931a47de4988d`; transcript hash remained `885b44e0eed027afcd457a9c98d2d6d5427a67967c808b8d912c9c2986f23fb7`.

Rollback rehearsal restored `/tmp/butler-sandy-v2.R13GaE/rollback.sqlite` from the independent snapshot: `integrity_check=ok`, works=41, bindings=52, results=3107, source Work `open`, audits=0.

## Product correction path

`operations/correction` exposes one audited operation. `correction sandy` is dry-run by default and locks the exact Sandy session, source Work, four Turns, source objective/scope, Plan revision/actions/checks, result counts (65/63/63/118), selected raw journal count (317), and source session head. Apply requires an explicit operator ID, reason, backup directory, and a generated owner-stop manifest for the canonical live path; `ownerStopped` alone is rejected. `correction sandy prepare-live` refuses known Butler owners, verifies database/WAL/SHM stability, creates both a byte-for-byte family bundle and independent SQLite backup, hashes all artifacts, writes a hash-authenticated expiring manifest, and prints only redacted hashes/timestamp metadata.

Apply performs one `BEGIN IMMEDIATE` transaction that re-reads and verifies the source rows, binding/result/tool-receipt digests, selected journal digest, semantic PRAGMAs, and expected hashes immediately before any write (volatile WAL/SHM mtimes are excluded from the in-transaction comparison). It creates the additive disposition/audit schema only after those assertions, creates the deterministic open capture Work and evidence plan/checkpoint, moves only the two capture bindings/results in journal order with exact change counts, records the monitoring disposition and an authoritative source closeout checkpoint, updates the sole session head, and appends one immutable audit receipt with redacted before/after snapshots, operator ID/reason, backup identity, and hashes. No journal, transcript, tool result, or raw message is deleted. The correction request fingerprint includes recipe/semantic evidence/operator/backup-manifest inputs; a replay revalidates the authenticated owner manifest and immutable audit before returning `already_applied` without another write.

## Backup, rollback, and recovery

Before any live apply, stop all Butler owners safely. Copy the database plus existing `-wal`/`-shm` files byte-for-byte and hash every copied file. Also create an independently openable SQLite snapshot with `VACUUM INTO`; run `PRAGMA integrity_check` and reopen it. Store both bundle/file hashes and the independent snapshot hash in the audit receipt. If any identity, count, digest, or integrity check differs, do not apply. To recover, stop owners, restore the verified database/WAL/SHM bundle as a unit, reopen and verify `integrity_check`, then restart and reverify Work/binding/result counts and the canonical session head. The trigger-abort rehearsal proved that an interrupted transaction leaves semantic rows and audit count unchanged; the independent snapshot is the recovery source.

No live apply, owner shutdown, or production restart was performed for this report.
