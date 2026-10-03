# Instructions with a lifetime

The October 3 owner decision supersedes the Recent feedback portions of
`operational-learning-restoration.md`. User instructions have one owner and one
remember tool, `update_explicit_memory`. The independent feedback tool, store,
UI and promotion path are retired. Existing cognition/feedback/feedback.md is
not migrated, read, written or deleted.

`duration` accepts `this chat`, `7 days`, or `always`. Missing duration means
always, preserving existing instructions. Session ownership is separate from
conversation provenance. This-chat instructions stop applying at explicit chat
closure or their fixed 24-hour expiry. Seven-day instructions use a fixed UTC
expiry. A repetition in the same scope upgrades a temporary instruction to
always and keeps its handle. The model reuses the saved text for an equivalent
restatement; the owner compares whitespace-normalized text, never guesses
semantic equivalence. `replaces` remains the correction operation.

The instruction owner persists atomic capture receipts before attempting the
consolidation lease. Active Rules and the settings inventory overlay pending
receipts immediately, including after restart. Capture never waits for that
lease. Canonical writes, correct/forget, daily expiry and project-reset fencing
remain lease-bound and data-authority guarded. The existing memory work signal
and consumer drain receipts; no additional timers, workers or idle scans are
introduced. Completed capture receipts are addressed by operation identity and
never scanned by admission. The existing instruction transaction preserves
crash checkpoints, source exclusion and recovery. Project reset drains accepted
captures before taking its exact instruction targets and advances the project's
receipt fence under the same lease.

Temporary/session instructions are carried in Active Rules, with deterministic
scope and fixed UTC expiry. They are not projected into semantic recall, which
must never resurrect an expired instruction. The existing daily triage phase
retires expired/session-ended entries through forget, recording `expired` or
`session_end` in operation metadata. A lasting repeat resumes the normal durable
semantic projection. Profile and conversation reset remain independent of
instructions; project reset includes its temporary instructions.

A complaint without a clear requested change is not stored. Tool and skill
copy direct the model to infer a concrete instruction only when intent is clear,
otherwise ask one short question.
