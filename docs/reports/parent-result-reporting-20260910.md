# Parent result verification and reporting

## Accepted intent

User approved repairing the existing parent continuation after a Steward result: retain authorized verification tools, do not mark all parent actions done at result arrival, and deliver the actual report rather than a promise. The existing BTCC loop, Work store, access policy and delivery outbox remain authoritative. Work disposition means the work is ready to report; Turn delivery remains the actual transport outcome. No additional runner, generic semantic answer classifier, retry policy or new delivery state machine.

## Tasks and acceptance

1. Bind the verified parent Work identity without synthesizing completion. Retain only existing authorized file/result readers and Work progress/review/disposition tools in the parent-result continuation. Preserve Worker-to-Steward integration and access boundaries.
2. Give the continuation an explicit task: review returned evidence, perform needed reads with available tools, close the same Work truthfully, and provide the result now. Scope review-progress instructions to tool-attached commentary, not final answers.
3. Verify an admitted parent through actual file read, explicit disposition, and final response. Verify the public result ingress/replay path where feasible. Replay the captured Qwen input with low/medium and current tool schemas, execute bounded reads only, and inspect final responses.
4. Review the diff, run focused tests/static gates, commit and apply to the running service with health checks.

No change to hosted provider wire protocols or automatic global reasoning defaults. Live Qwen probes explicitly pass effort; shipping a general local reasoning capability registry is outside this approved reporting correction.

Plan review: parent result identity comes from resolveParentResultEvidence; tools are an intersection with the admitted authorization surface. Reads still use existing workspace/path checks. Returned child evidence is data, not instructions. Parent completion is model-authored through the existing Work closeout, not inferred from child success. Transport completion is checked separately.

## Results

- Removed runtime-authored parent completed disposition/all-actions-done at child result arrival. Verified parent Work binding remains.
- Replaced the empty terminal surface with an intersection of admitted authorization and read_file/list_files/list_operation_results/read_operation_results plus existing checkpoint/review/disposition tools. No write/command/delegation capability is added.
- Parent-result prompt now directs verification and the actual current report; Review commentary restrictions explicitly exclude the final answer. Worker result integration branch is unchanged.
- Scripted admitted production agent regression passed: parent open before/after actual file read, no synthetic disposition, explicit model closeout, real final body. Read and closeout are journaled through production executors.
- Opt-in live Qwen smoke passed for low/medium/xhigh on the same production agent and local provider adapter with temporary isolated Work/SQLite/workspace. It explicitly injects the requested wire effort only in the probe; normal tests do not contact the server. Each final body includes a code only available from the actual file and the unverified item. First run low/medium took three rounds each; recheck low took four (including checkpoint), medium and xhigh took three. Final recheck: 2 tests passed, 32 assertions, 72.91 seconds.
- Captured failing long parent input, with current tool schemas plus the explicit continuation instruction, now returns typed calls: low read_file (8.53s/128 generated tokens), medium list_files + list_operation_results (11.37s/480 tokens), finish_reason=tool_calls. These two captured-input probes stop before executing their calls; complete real reads/closeout/body are covered by the isolated production-agent live smoke, not falsely claimed as a full replay of the historical live Work.
- The actual historical parent and child share /Users/yeonwoo/.butler and the briefing file exists there, so its read does not require new workspace access.
- Backend TypeScript, focused ESLint and diff whitespace checks passed. Architecture audit flagged only existing large files (599/342/358 lines); review found no new module/runner/state owner, and the runtime flow shrank.
- Wider pre-existing Worker result test fails on stale expected closeout wording. Existing public restart/busy-parent test fails before result ingress because its fixture does not produce a delegation. A temporary fixture investigation progressed to another stale child receipt assertion; that unrelated test edit was discarded. Full public ingress/restart acceptance is not claimed from these tests.
- Review: user-visible verification now has a real authorized tool path, child success alone cannot complete parent actions, and the ordinary explicit Work disposition/final delivery distinction is retained. This is not a general semantic detector for every possible promise-only model answer. Prior completed operational Work records are not rewritten.

## Rollout

Commit/restart pending.
