---
name: save-feedback
description: Remember an explicit rule or preference.
user-invocable: true
applicability: Use only when the user explicitly asks to remember a durable rule or preference.
allowed-tools: update_explicit_memory
dispatch: none
review: none
reporting: Confirm only a successful durable rule update.
---

Use `update_explicit_memory` with `kind: "rule"`, the complete rule in `text`,
and a short provenance summary in `source`.

To correct a saved rule, copy its handle from Active Rules into `replaces`.
Choose only the rule the user identifies. If the target is ambiguous, ask which
rule. A chat can change only rules in its own binding; use a general chat for
All chats rules. Do not create a second rule to bypass a failed correction.

The server owns files, handles, revisions and recovery. Never edit memory files
or indexes directly. Confirm success only when the tool returns `ok: true`;
on a stale rule, ask the user to review the latest rule. Recall projection of
new text may still be pending.
