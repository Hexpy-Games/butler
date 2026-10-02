# Project artifact lookup

`project_artifacts` searches delivered assistant attachments in the runtime-bound
App project. There is no project-id argument. Chats without a project return
`no_project`; a foreign handle returns `source_unavailable`. This uses the
existing `chats → messages → message_attachments → message_files` relations,
including old deliveries. Unregistered generated files, user attachments and
failed deliveries are excluded. No Box, memory, generation or scheduling code
participates.

A name search ranks exact titles before substring matches. `type` matches a MIME
type or registration kind exactly. Items include a safe title, type, size,
origin session/turn/message and `{id, revision}` read handle. The file-registration
id is stable; multiple attachments of it resolve to the latest delivered origin.
Different registrations with the same title remain distinct: a title does not
establish revision identity. The registration's current SHA-256 and size are the
accepted content revision. Revising a generated source without publishing it does
not change the already delivered snapshot.

Use `next_cursor` unchanged with the same filters until it is null. Every page
reports the complete current matching count. Order is exact-title rank, latest
message row descending, then file id descending. A page contains at most 100
complete items and fits the existing 50 KiB provider result budget; larger
metadata continues on a subsequent page. Counts and metadata come from one
read transaction. A streaming digest of complete matching metadata binds the
cursor to its result set. Publication, deletion, revision or changed origin during
pagination returns `source_changed`: begin again without a cursor to obtain the
latest complete set. There is no stale persisted list or snapshot cache.

Passing `read_handle` explicitly selects content. Each read resolves project
membership and the current registered revision again, then calls the existing
`AttachmentContext::read_project_source` reader. That reader opens a regular
snapshot without following a symlink and checks size and SHA-256. Missing/deleted
content returns `source_unavailable`; a superseded handle or changed digest returns
`source_snapshot_changed`. UTF-8 content preserves exact bytes across character
boundaries; other content is base64. Continue its `next_cursor` with the same
handle to obtain all bytes. Read cursors bind project, id and digest.

Per call: a listing opens one read-only App DB connection and runs two metadata
SELECTs (streaming count/revision and page) using project/chat/message/attachment
indexes. Each traverses the current project's delivered attachment relations;
unrelated project history is excluded by the indexed project binding. The adapter
reads every matching metadata row for the count/revision and at most
101 page rows, with bounded memory and zero content files. A content page runs
one scoped metadata SELECT and reads and
hashes one complete accepted file, including on continuation. The existing reader
limit remains 10 MiB. Pages return up to 18,000 source bytes, adjusting for UTF-8
boundaries and JSON escaping to stay inside the existing provider budget. No
prompt/context budget, file-reader limit or performance budget is raised. No
artifact contents or artifact list is added to prompts. The tool is available
through the existing tool catalog.

SQLite queries run on blocking workers with cancellation progress checks and no
busy wait; cancellation also interrupts awaiting content. No new store, content
copy, ingestion, lease mutation, timer, admission/startup/shutdown hook or idle
I/O is introduced. The only persistent addition is a project-key index on the
existing App `chats` table, installed by its guarded schema setup. Tool operation
receipts retain the existing journal/authority path.

Stub coverage is in `butler-e2e/tests/project_artifacts.rs`: real publication from
chat A, restart, chat B lookup/citation/read, other-project and no-project isolation,
foreign arguments/handles, registered revisions, missing/deleted files, Unicode
continuation, binary content and symlink rejection. Its scale fixture includes
600 unrelated chats, 300,000 unrelated messages, 13,312 project registrations and
257 matches with complete count/order/latest-origin assertions. Timings use
existing journal timestamps and the 150 ms App read budget in isolated perf mode.

Measured on the Linux build host: both acceptance tests passed with the performance
gate enabled. The cross-chat lifecycle calls took 0–8 ms. The scale App DB was
2,828,537,856 bytes; all 257 matches arrived in three compact pages or four pages
with long titles. Compact page calls took 84–92 ms, and all scale calls stayed
below 150 ms. Each assertion also compares the complete durable result with the
actual model-visible tool output, guarding against provider preview truncation.

The existing 60-second idle regression passed with zero graph commits and leases,
and unchanged graph/WAL/lock files. Whole-agent counters recorded 69,427 read
characters and 90,112 physical read bytes; these include existing service work.
Artifact lookup introduces no idle reader: its DB/file calls are reachable only
from an explicit tool invocation. Migration refusal and configuration durability
regressions also passed.
