# Native file tools

Butler native file tools provide bounded, workspace-scoped file access without shelling out for ordinary discovery, read, write, edit, and search operations.

## Shared safety contract

- Tools require a workspace root from Butler session/project metadata or the calling runtime.
- User paths are workspace-relative. Absolute paths, parent traversal, sensitive paths, special files/devices, and symlink escapes are rejected by the workspace path guard.
- Text operations reject likely binary content and bound bytes, lines, matches, and context.
- `list_files` is structural discovery only: it returns deterministic workspace-relative regular-file `{path, bytes}` entries and skips default generated/vendor roots, sensitive paths, and symlinks.
- `list_files` and `grep_files` share one bounded traversal owner. Include/exclude globs are applied while walking, and partial results carry `stopped_by` plus an opaque `next_cursor` when a safe continuation is possible.
- Cursors are versioned, URL-safe, query-bound tokens. `read_file` cursors additionally bind a partially-read file to its complete SHA-256 and fail with `cursor_stale` if the file changes.
- Canonical public glob fields are `include_globs` and `exclude_globs`; replay-only `include`/`exclude` aliases are normalized at the executor boundary and are not advertised.

## Evidence receipt contract

Each native file tool returns `evidence_receipts` using `butler.evidence-receipt.v1`. Receipts identify the producer tool, verification state, covered workspace-file action, bounded references, and completion obligations satisfied by the operation.

- `list_files`: reports bounded root/glob scope, regular-file count, traversal caps, and continuation state without file content or absolute paths.
- `read_file`: preserves the single `path` result (byte count, line range, truncation, SHA-256) and accepts canonical `requests` batches of 1–20 files with per-file and aggregate byte bounds. Batch entries remain in request order and isolate typed per-file failures.
- `write_file`: reports path, created/overwritten state, before/after SHA-256, byte count, and atomic-write status.
- `edit_file`: replaces one exact range beginning at a one-based line, preserves the file mode, and reports the before/after SHA-256. Single edits retain the established exact-text contract; canonical `edits` batches contain 2–20 distinct paths, require each current expected SHA-256, preflight every entry before mutation, and report bounded applied/conflicting/not-attempted state without rollback on external change.
- `grep_files`: reports literal/regex mode, case sensitivity, searched/skipped file counts, match truncation, and bounded match data under `max_output_bytes`. Candidate reads are bounded; matches use established source-priority then path/line ordering with a same-window cursor; invalid UTF-8 and binary files are counted and skipped.

`run_command` remains available for build, test, transform, and multi-step shell execution. It should not be the default path for simple workspace file read/write/edit/search once these native tools are available.
