import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  activeDirectWorkProgressSnapshot,
  directWorkSemanticProgressAdvanced,
  finalDeliveryBlockerForOpenDirectWork,
  finalDeliveryBlockerForOpenProjectLedgerTaskRefs,
  openDirectWorkContinuationPrompt,
  RUNTIME_SEMANTIC_TODO_LIST_ID,
  turnAdvancedDuringToolPrompt,
} from "../../packages/butler-agent/src/agent/turn/direct-work-continuation.ts";
import { WorkStreamStore } from "../../packages/butler-agent/src/agent/work/work-stream.ts";
import {
  TodoListStore,
  type TodoItemInput,
} from "../../packages/butler-agent/src/agent/work/todo-list.ts";

test("direct work snapshot ignores synthetic runtime and linked async streams", () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-direct-work-"));
  createStream(butlerData, {
    sessionId: "session-a",
    listId: RUNTIME_SEMANTIC_TODO_LIST_ID,
    items: [todo("runtime progress", "in_progress")],
  });
  createStream(butlerData, {
    sessionId: "session-b",
    listId: "linked",
    items: [todo("linked progress", "in_progress")],
    workerTaskIds: ["worker-1"],
  });

  expect(activeDirectWorkProgressSnapshot({ butlerData, sessionId: "session-a" })).toEqual({
    kind: "none",
  });
  expect(activeDirectWorkProgressSnapshot({ butlerData, sessionId: "session-b" })).toEqual({
    kind: "none",
  });
});

test("direct work blocker returns active direct todo steps and clears when deliverable", () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-direct-work-"));
  createStream(butlerData, {
    sessionId: "session",
    listId: "main",
    title: "Ship direct work",
    items: [
      todo("Plan work", "completed", "planning"),
      todo("Run verification", "in_progress", "review"),
      todo("Write final report", "pending", "reporting"),
    ],
  });

  expect(finalDeliveryBlockerForOpenDirectWork({ butlerData, sessionId: "session" }))
    .toEqual(expect.objectContaining({
      title: "Ship direct work",
      state: "reviewing",
      phase: "review",
      activeItems: [
        expect.objectContaining({ label: "Run verification", status: "in_progress" }),
        expect.objectContaining({ label: "Write final report", status: "pending" }),
      ],
    }));

  createStream(butlerData, {
    sessionId: "session",
    listId: "main",
    title: "Ship direct work",
    items: [
      todo("Plan work", "completed", "planning"),
      todo("Run verification", "completed", "review"),
      todo("Write final report", "completed", "reporting"),
    ],
  });

  expect(finalDeliveryBlockerForOpenDirectWork({ butlerData, sessionId: "session" })).toBeNull();
  expect(activeDirectWorkProgressSnapshot({ butlerData, sessionId: "session" })).toEqual({
    kind: "none",
  });
});

test("Project Ledger task refs in final text block delivery while referenced work remains open", () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-direct-work-"));
  const workspacePath = join(mkdtempSync(join(tmpdir(), "sandy-bot-")), "workspace");
  mkdirSync(workspacePath, { recursive: true });
  writeFileSync(join(workspacePath, "package.json"), JSON.stringify({ name: "sandy-bot" }), "utf8");
  writeProjectLedgerIndex(butlerData, "sandy-bot", [
    ledgerRecord("W-SANDY-MEMORY-CHUNK-CHECKPOINT", "work", "Sandy message chunk and checkpoint model", "specified"),
    ledgerRecord("T-SANDY-050-CHECKPOINT-STORE", "task", "Add checkpoint store", "done", "W-SANDY-MEMORY-CHUNK-CHECKPOINT"),
    ledgerRecord("T-SANDY-051-CHUNK-SELECTION", "task", "Add chunk selection", "done", "W-SANDY-MEMORY-CHUNK-CHECKPOINT"),
    ledgerRecord("T-SANDY-052-CHUNK-CHECKPOINT-TESTS", "task", "Add chunk/checkpoint integration tests", "todo", "W-SANDY-MEMORY-CHUNK-CHECKPOINT"),
  ]);

  const blocker = finalDeliveryBlockerForOpenProjectLedgerTaskRefs({
    butlerData,
    butlerHome: workspacePath,
    workspacePath,
    candidateText: "T-SANDY-051 is done. Next start point is `T-SANDY-052-CHUNK-CHECKPOINT-TESTS`.",
  });

  expect(blocker).toEqual(expect.objectContaining({
    id: "W-SANDY-MEMORY-CHUNK-CHECKPOINT",
    title: "Sandy message chunk and checkpoint model",
    phase: "project-ledger",
    activeItems: [
      expect.objectContaining({
        id: "T-SANDY-052-CHUNK-CHECKPOINT-TESTS",
        status: "todo",
      }),
    ],
  }));
});

test("Project Ledger task refs do not block delivery after referenced tasks are terminal", () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-direct-work-"));
  const workspacePath = join(mkdtempSync(join(tmpdir(), "sandy-bot-")), "workspace");
  mkdirSync(workspacePath, { recursive: true });
  writeFileSync(join(workspacePath, "package.json"), JSON.stringify({ name: "sandy-bot" }), "utf8");
  writeProjectLedgerIndex(butlerData, "sandy-bot", [
    ledgerRecord("W-SANDY-MEMORY-CHUNK-CHECKPOINT", "work", "Sandy message chunk and checkpoint model", "specified"),
    ledgerRecord("T-SANDY-052-CHUNK-CHECKPOINT-TESTS", "task", "Add chunk/checkpoint integration tests", "done", "W-SANDY-MEMORY-CHUNK-CHECKPOINT"),
  ]);

  expect(finalDeliveryBlockerForOpenProjectLedgerTaskRefs({
    butlerData,
    butlerHome: workspacePath,
    workspacePath,
    candidateText: "T-SANDY-052-CHUNK-CHECKPOINT-TESTS is complete.",
  })).toBeNull();
});

test("direct work progress requires semantic workstream advancement before tool counts", () => {
  const before = {
    kind: "active" as const,
    id: "work-1",
    state: "planning" as const,
    deliverable: false,
    completedCount: 1,
    unfinishedCount: 2,
  };
  const after = {
    kind: "active" as const,
    id: "work-1",
    state: "executing" as const,
    deliverable: false,
    completedCount: 1,
    unfinishedCount: 2,
  };

  expect(directWorkSemanticProgressAdvanced(before, after)).toBe(true);
  expect(turnAdvancedDuringToolPrompt({
    beforeWork: before,
    afterWork: before,
    successfulToolsBefore: 1,
    successfulToolsAfter: 2,
  })).toBe(false);
  expect(turnAdvancedDuringToolPrompt({
    beforeWork: { kind: "none" },
    afterWork: { kind: "none" },
    successfulToolsBefore: 1,
    successfulToolsAfter: 2,
  })).toBe(true);
});

test("direct work continuation prompt carries sanitized context and receipts", () => {
  const prompt = openDirectWorkContinuationPrompt({
    objective: "Finish the report\nwith evidence.",
    personaContext: "  Stay concise.\n\nAvoid meta talk. ",
    audit: [{
      name: "run_command",
      args: {},
      ok: true,
      result: {},
      evidenceReceipts: [{
        schema: "butler.evidence-receipt.v1",
        id: "receipt-1",
        producer: {
          kind: "tool",
          name: "run_command",
        },
        receiptType: "execution",
        verified: true,
        covers: ["command_execution"],
        summary: "verified csv output",
        references: [],
      }],
    }],
    blocker: {
      id: "ws-direct-report",
      title: "Direct report",
      state: "reviewing",
      phase: "review",
      listId: "main",
      activeItems: [{
        id: "verify",
        label: "Verify the generated file",
        status: "in_progress",
        phase: "review",
      }],
    },
  });

  expect(prompt).toContain("Persona continuation:\nStay concise. Avoid meta talk.");
  expect(prompt).toContain("1. [in_progress/review] Verify the generated file");
  expect(prompt).toContain("evidence 1: run_command; receipts: verified csv output");
  expect(prompt).toContain("- objective: Finish the report with evidence.");
});

function createStream(inputButlerData: string, input: {
  sessionId: string;
  listId: string;
  title?: string;
  items: TodoItemInput[];
  workerTaskIds?: string[];
}): void {
  const store = new WorkStreamStore(inputButlerData);
  const todoView = new TodoListStore(inputButlerData).update({
    listId: input.listId,
    title: input.title ?? "Direct work",
    items: input.items,
  });
  const record = store.updateFromTodoList({
    ownerSessionId: input.sessionId,
    projectId: "project",
    listId: input.listId,
    title: input.title ?? "Direct work",
    items: todoView.list.items,
  });
  if (input.workerTaskIds) {
    store.link({
      id: record.id,
      workerTaskIds: input.workerTaskIds,
    });
  }
}

function ledgerRecord(
  id: string,
  kind: string,
  title: string,
  status: string,
  parentId: string | null = null,
) {
  return { id, kind, title, status, parentId };
}

function writeProjectLedgerIndex(
  butlerData: string,
  projectId: string,
  records: Array<ReturnType<typeof ledgerRecord>>,
): void {
  const indexDir = join(butlerData, "project-ledger", "projects", projectId, "index");
  mkdirSync(indexDir, { recursive: true });
  writeFileSync(
    join(indexDir, "project.json"),
    JSON.stringify({ schema: "project-ledger.index.v1", records }, null, 2),
    "utf8",
  );
}

function todo(
  content: string,
  status: TodoItemInput["status"],
  phase: TodoItemInput["phase"] = "execution",
): TodoItemInput {
  return {
    content,
    active_form: `${content.replace(/^\w/u, (match) => match.toUpperCase())}`,
    status,
    phase,
    priority: "normal",
  };
}
