# Native file tools

Butler native file tools provide bounded, workspace-scoped file access without shelling out for ordinary read, write, edit, and search operations.

## Shared safety contract

- Tools require a workspace root from Butler session/project metadata or the calling runtime.
- User paths are workspace-relative. Absolute paths, parent traversal, sensitive paths, special files/devices, and symlink escapes are rejected by the workspace path guard.
- Text operations reject likely binary content and bound bytes, lines, matches, and context.

## Evidence receipt contract

Each native file tool returns `evidence_receipts` using `butler.evidence-receipt.v1`. Receipts identify the producer tool, verification state, covered workspace-file action, bounded references, and completion obligations satisfied by the operation.

- `read_file`: reports path, byte count, line range, truncation state, and SHA-256.
- `write_file`: reports path, created/overwritten state, before/after SHA-256, byte count, and atomic-write status.
- `edit_file`: replaces one exact range beginning at a one-based line, preserves the file mode, and reports the before/after SHA-256. Use it for a small change to an existing UTF-8 file.
- `grep_files`: reports pattern mode, case sensitivity, searched/skipped file counts, match truncation, and bounded match data.

`run_command` remains available for build, test, transform, and multi-step shell execution. It should not be the default path for simple workspace file read/write/edit/search once these native tools are available.
