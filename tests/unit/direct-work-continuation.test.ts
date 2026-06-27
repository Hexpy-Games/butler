import { expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  activeDirectWorkProgressSnapshot,
  directWorkSemanticProgressAdvanced,
  finalDeliveryBlockerForOpenDirectWork,
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
