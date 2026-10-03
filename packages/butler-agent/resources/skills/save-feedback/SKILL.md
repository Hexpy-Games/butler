---
name: save-feedback
description: Save or correct Instructions and Recent feedback.
user-invocable: true
applicability: Explicit user instructions, corrections or tool/source complaints.
allowed-tools: update_explicit_memory forget_explicit_memory record_user_feedback
dispatch: none
review: none
reporting: Confirm only successful capture.
---

Clear durable instructions/preferences go directly to `update_explicit_memory`
with `kind: "rule"`, complete text and a short `source` summary. A correction to
saved Instructions uses its Active Rules handle in `replaces`; forgetting uses
`forget_explicit_memory`. Never create another instruction to bypass a failed
correction. The runtime binds the project and owns handles and recovery.

Save situational corrections and tool/source complaints with
`record_user_feedback` before answering; apply them immediately and on the next
matching turn. Bind scope narrowly: global, current project or current session.
Use ephemeral for 7-day situational feedback, working for unresolved 90-day
cross-turn corrections, session_only for session end/24h, pinned only if requested.
A quality complaint calls for revalidation, never an invented source ban.
If the scope or target is ambiguous, use unrouted/needs_clarification and ask
one narrow question before applying policy. Never include secrets or sensitive
raw text. Confirm `ok: true` with “반영했어요.” / “Feedback saved.”
