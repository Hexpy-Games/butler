import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { BTCC_SUCCESSOR_SCHEMA } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { SqliteGuidedToolJournal } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/guided-tool-journal.ts";
import { SqliteSubsessionDelegationStore } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/subsession-store.ts";
import { SqliteStewardObserverStore } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/steward-observer-store.ts";
import { changedFileDetail, type ChangedFileDetail } from "../../packages/butler-agent/src/agent/tools/file-tools/shared/changed-file-detail.ts";
import { collectGuidedChangedFiles } from "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-changed-files.ts";
import { resolveParentResultEvidence } from "../../packages/butler-agent/src/agent/btcc/subsessions/accepted-terminal-report.ts";
import { sessionViewForStewardObserver } from "../../packages/butler-agent/src/gateways/app/domain/sessions/steward-observer-view.ts";

test("delegated changes survive a review-only continuation through Worker, Steward and Butler", async () => {
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  const journal = new SqliteGuidedToolJournal(db);
  const store = new SqliteSubsessionDelegationStore(db);
  try {
    relation("a1", "butler", "steward");
    relation("a2", "steward", "worker");
    relation("a3", "butler", "unrelated-steward");
    turn("worker-implementation", "worker");
    turn("steward-correction", "steward");
    turn("steward-review", "steward");
    turn("unrelated", "unrelated-steward");

    mutate("worker-implementation", "worker-edit", "src/app.ts", "old\n", "worker\n");
    mutate("worker-implementation", "worker-temporary", "src/temp.ts", "old\n", "temporary\n");
    const worker = commit("a2", "worker-implementation", []);
    expect(worker.result.changed_files?.map((file) => file.path)).toEqual([
      "src/app.ts", "src/temp.ts",
    ]);

    mutate("steward-correction", "steward-edit", "src/app.ts", "worker\n", "final\n");
    mutate("steward-correction", "steward-test", "tests/app.test.ts", "", "test\n");
    mutate("steward-correction", "steward-revert", "src/temp.ts", "temporary\n", "old\n");
    mutate("unrelated", "unrelated-edit", "src/unrelated.ts", "", "unrelated\n");
    const ownChanges = collectGuidedChangedFiles(journal.list("steward-correction"));
    message("steward-correction", "assistant-correction", ownChanges);
    message("steward-review", "assistant-complete", []);

    // The last execution only reviews/reports: no new file tools and no newly changed files.
    const final = commit("a1", "steward-review", []);
    const expected: ChangedFileDetail[] = [
      { path: "src/app.ts", additions: 1, deletions: 1, lines: [
        { type: "deleted", old_line: 1, content: "old" },
        { type: "added", new_line: 1, content: "final" },
      ] },
      { path: "tests/app.test.ts", additions: 1, deletions: 0, lines: [
        { type: "added", new_line: 1, content: "test" },
      ] },
    ];
    expect(final.result.changed_files).toEqual(expected);
    expect(store.resultByRelationId("relation-a1")?.changed_files).toEqual(expected);
    expect(JSON.stringify(final.result.changed_files)).not.toContain("before_text");

    const evidence = await resolveParentResultEvidence({
      parentSessionId: "butler",
      parentInputText: final.parentInput.text,
      store,
      turns: { findTurn: async () => null },
    });
    expect(collectGuidedChangedFiles([], evidence?.changedFiles)).toEqual(expected);
    expect(evidence?.synthesisEvidence).not.toContain("src/app.ts");

    const observer = new SqliteStewardObserverStore(db);
    const view = sessionViewForStewardObserver(
      observer.relationById("relation-a1")!, observer.snapshot("steward"), 0,
    );
    expect(view.messages.find((row) => row.id === "assistant-correction")?.changed_files)
      .toEqual(ownChanges);
    expect(view.messages.find((row) => row.id === "assistant-complete")?.changed_files)
      .toEqual(expected);
    expect(view.messages.filter((row) => row.role === "user").every((row) =>
      !row.changed_files?.length)).toBe(true);
  } finally {
    db.close();
  }

  function relation(id: string, parent: string, child: string) {
    db.query("INSERT INTO btcc_session_relations VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(`relation-${id}`, parent, `parent-turn-${id}`, child, `anchor-${id}`, Number(id.slice(1)),
        "File changes", "2026-09-02T00:00:00.000Z");
    db.query(`INSERT INTO btcc_subsession_delegations (
      delegation_id, relation_id, task_id, child_turn_id, root_work_id, packet_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(`delegation-${id}`, `relation-${id}`, `task-${id}`, `initial-${child}`,
        `work-${id}`, JSON.stringify({
          objective: "Implement the change",
          parent_work_ref: { work_id: `work-${id}` },
          access_and_budget_policy: { access_mode: "full_access" },
        }), "2026-09-02T00:00:00.000Z");
  }

  function turn(id: string, sessionId: string) {
    db.query(`INSERT INTO btcc_turns (
      turn_id, session_id, inbox_id, trigger_key, original_message_id,
      original_message, admission_snapshot_ref, model_selection_json,
      context_json, semantic_state, revision, execution_fence
    ) VALUES (?, ?, ?, ?, ?, '', ?, '{}', '{}', 'delivered', 1, 0)`)
      .run(id, sessionId, `inbox-${id}`, `trigger-${id}`, `input-${id}`, `snapshot-${id}`);
  }

  function mutate(turnId: string, callId: string, path: string, before: string, after: string) {
    journal.start({ turnId, callId, toolName: "edit_file", rawArguments: "{}", arguments: {} });
    journal.finish({ callId, status: "completed", result: { ok: true },
      changedFiles: [changedFileDetail(path, before, after)!] });
  }

  function message(turnId: string, id: string, changedFiles: ChangedFileDetail[]) {
    const createdAt = id === "assistant-complete"
      ? "2026-09-02T00:02:00.000Z" : "2026-09-02T00:01:00.000Z";
    db.query(`UPDATE btcc_turns SET canonical_assistant_message_id = ?, final_payload_json = ?
      WHERE turn_id = ?`).run(id, JSON.stringify({ content: "Done", changedFiles }), turnId);
    db.query("INSERT INTO btcc_messages VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, "steward", turnId, "assistant", "Done", `message-${id}`, createdAt);
  }

  function commit(id: string, childTurnId: string, changedFiles: ChangedFileDetail[]) {
    return store.commitResult({
      relation: store.relationById(`relation-${id}`)!, childTurnId,
      resultId: `steward-result-${id}`, taskId: `task-${id}`,
      modelRef: "test/model", reasoningEffort: "medium", status: "success", code: null,
      summary: "Completed", acceptanceEvidence: [], changedArtifacts: [], changedFiles,
      commits: [], tests: [], remainingRisks: [], followUpRecommendations: [], detailRefs: [],
      parentChatId: "butler",
    });
  }
});
