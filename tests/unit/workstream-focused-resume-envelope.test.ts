import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { normalizeTurnPrompt } from "../../packages/butler-agent/src/agent/turn/native/context/turn-prompt.ts";
import { promptUsageSectionsFromPrompt } from "../../packages/butler-agent/src/agent/turn/direct-turn-budget.ts";
import { selectWorkStreamCheckpointResume } from "../../packages/butler-agent/src/agent/turn/workstream-checkpoint-resume-controller.ts";
import {
  buildFocusedResumeEnvelope,
  turnMetadataWithFocusedResumePolicy,
} from "../../packages/butler-agent/src/agent/turn/workstream-focused-resume-envelope.ts";
import { WorkStreamStore, type WorkStreamRecord } from "../../packages/butler-agent/src/agent/work/work-stream.ts";
import { TodoListStore, type TodoItemInput } from "../../packages/butler-agent/src/agent/work/todo-list.ts";
import { selectInitialToolsFromSurfaceController } from "../../packages/butler-agent/src/agent/tools/tool-surface-selection.ts";
import {
  appendRuntimeTurnContextMetric,
  contextMetricsPath,
} from "../../packages/butler-agent/src/operations/metrics/context-monitor.ts";
import type { RuntimeTurnInput } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";

let tempDir = "";

beforeEach(() => {
  tempDir = join(tmpdir(), `butler-focused-resume-${Date.now()}-${Math.random()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test("focused resume envelope hydrates only selected checkpoint and relevant Project Ledger records", () => {
  const stream = createRecoverableStream();
  writeProjectLedgerIndex({
    projectId: "butler",
    records: [
      {
        id: "execute",
        kind: "task",
        title: "Execute selected repair",
        status: "in_progress",
        path: "project-ledger/projects/butler/work/W/tasks/execute.md",
      },
      {
        id: "UNRELATED-LEDGER-RECORD",
        kind: "task",
        title: "Unrelated task",
        status: "todo",
        path: "project-ledger/projects/butler/work/other.md",
      },
    ],
  });

  const selection = selectWorkStreamCheckpointResume({
    butlerData: tempDir,
    sessionId: "butler/session",
    projectId: "butler",
    userText: "개석해",
  });
  const envelope = buildFocusedResumeEnvelope({
    butlerData: tempDir,
    selection,
    currentUserText: "개석해",
  });
  const turnMetadata = turnMetadataWithFocusedResumePolicy({
    runtimePolicy: { completionReview: "disabled" },
  }, envelope);
  const toolNames = selectInitialToolsFromSurfaceController({
    role: "butler",
    message: "개석해",
    sessionMetadata: { projectId: "butler" },
    turnMetadata,
    providerCapabilities: {
      supportsToolCalls: true,
      supportsStreaming: true,
    },
  }).toolNames;

  expect(selection.selected?.id).toBe(stream.id);
  expect(envelope?.prompt).toContain("## Focused WorkStream Resume Envelope");
  expect(envelope?.prompt).toContain("WorkStream State: recoverable");
  expect(envelope?.prompt).toContain("task:execute:in_progress:Execute selected repair");
  expect(envelope?.prompt).not.toContain("UNRELATED-LEDGER-RECORD");
  expect(toolNames).toEqual(expect.arrayContaining([
    "project_ledger_show",
    "project_ledger_status",
    "run_command",
    "read_file",
    "grep_files",
    "update_todo_list",
    "list_work_streams",
    "update_work_stream_state",
  ]));
  expect(toolNames).not.toContain("web_search");
  expect(toolNames).not.toContain("create_planned_task");
  expect(toolNames).not.toContain("create_work_orchestration");
});

test("focused resume prompt excludes broad recent conversation and prompt-context work sections", () => {
  const selection = selectWorkStreamCheckpointResume({
    butlerData: tempDir,
    sessionId: "butler/session",
    projectId: "butler",
  });
  expect(selection.state).toBe("fresh_turn");

  createRecoverableStream();
  const resumed = selectWorkStreamCheckpointResume({
    butlerData: tempDir,
    sessionId: "butler/session",
    projectId: "butler",
    userText: "ㅇㅇ",
  });
  const envelope = buildFocusedResumeEnvelope({
    butlerData: tempDir,
    selection: resumed,
    currentUserText: "ㅇㅇ",
  });
  expect(envelope).not.toBeNull();

  const normalized = normalizeTurnPrompt(runtimeTurnInput({
    promptContext: [
      "## Stable Context",
      "KEEP_CONTEXT_SENTINEL",
      "## Active Work State",
      "UNRELATED_WORKSTREAM_SENTINEL",
      "## Project Ledger Runtime Context",
      "BROAD_LEDGER_SENTINEL",
    ].join("\n"),
    text: "ㅇㅇ",
  }), {
    butlerData: tempDir,
    recentConversationTokenBudget: 1_000,
    focusedResumeEnvelope: envelope!.prompt,
    removePromptContextSections: ["Active Work State", "Project Ledger Runtime Context"],
    skipRecentConversation: true,
    conversationReader: throwingConversationReader(),
  });
  const sections = promptUsageSectionsFromPrompt(normalized);

  expect(normalized.prompt).toContain("KEEP_CONTEXT_SENTINEL");
  expect(normalized.prompt).toContain("## Focused WorkStream Resume Envelope");
  expect(normalized.prompt).toContain("Current User Instruction Delta:\nㅇㅇ");
  expect(normalized.prompt).not.toContain("UNRELATED_WORKSTREAM_SENTINEL");
  expect(normalized.prompt).not.toContain("BROAD_LEDGER_SENTINEL");
  expect(normalized.prompt).not.toContain("## Recent Conversation");
  expect(normalized.recentConversationChars).toBe(0);
  expect(normalized.focusedResumeEnvelopeChars).toBeGreaterThan(0);
  expect(sections).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "focused_resume_envelope" }),
  ]));
});

test("focused resume context metrics store only counts, not envelope text", () => {
  const envelopeText = "## Focused WorkStream Resume Envelope\nSECRET_ENVELOPE_TEXT";

  appendRuntimeTurnContextMetric({
    butlerData: tempDir,
    sessionId: "butler/session",
    model: "mock/model",
    totalPromptChars: envelopeText.length,
    promptContextChars: 0,
    recentConversationChars: 0,
    recallContextChars: 0,
    inboundMessageChars: 2,
    focusedResumeEnvelopeChars: envelopeText.length,
  });

  const raw = readFileSync(contextMetricsPath(tempDir), "utf8");
  expect(raw).toContain("\"focusedResumeEnvelopeChars\"");
  expect(raw).not.toContain("SECRET_ENVELOPE_TEXT");
});

function createRecoverableStream(): WorkStreamRecord {
  const todoView = new TodoListStore(tempDir).update({
    listId: "T-WCRC-03-FOCUSED-ENVELOPE",
    title: "Focused resume work",
    items: [
      todo({ id: "plan", content: "Plan selected repair", status: "completed", phase: "planning" }),
      todo({ id: "execute", content: "Execute selected repair", status: "in_progress", phase: "execution" }),
      todo({ id: "report", content: "Report selected repair", status: "pending", phase: "reporting" }),
    ],
    now: new Date("2026-07-03T00:00:00.000Z"),
  });
  const stream = new WorkStreamStore(tempDir).updateFromTodoList({
    ownerSessionId: "butler/session",
    projectId: "butler",
    listId: todoView.list.list_id,
    title: "Focused resume work",
    items: todoView.list.items,
    now: new Date("2026-07-03T00:00:00.000Z"),
  });
  return new WorkStreamStore(tempDir).transition({
    id: stream.id,
    state: "recoverable",
    now: new Date("2026-07-03T00:01:00.000Z"),
  });
}

function todo(input: {
  id: string;
  content: string;
  status: TodoItemInput["status"];
  phase: TodoItemInput["phase"];
}): TodoItemInput {
  return {
    ...input,
    active_form: input.content,
    priority: "normal",
    blocked_by: [],
  };
}

function writeProjectLedgerIndex(input: {
  projectId: string;
  records: Array<Record<string, unknown>>;
}): void {
  const indexDir = join(tempDir, "project-ledger", "projects", input.projectId, "index");
  mkdirSync(indexDir, { recursive: true });
  writeFileSync(join(indexDir, "project.json"), JSON.stringify({
    schema: "project-ledger.index.v1",
    records: input.records,
  }), "utf8");
}

function runtimeTurnInput(input: {
  promptContext: string;
  text: string;
}): RuntimeTurnInput {
  return {
    handle: {
      sessionId: "butler/session",
      role: "butler",
      runtimeAdapterId: "native-tool-loop",
    },
    provider: {
      id: "mock-provider",
      capabilities: {
        supportsStreaming: false,
        supportsToolCalls: true,
        supportsImages: false,
        supportsAudio: false,
        supportsServerThreads: false,
        supportsReasoningConfig: false,
        supportsPromptCaching: false,
      },
      async invoke() {
        return { text: "unused" };
      },
    },
    model: "mock/model",
    input: { text: input.text },
    metadata: {
      promptContext: input.promptContext,
    },
  };
}

function throwingConversationReader(): any {
  return {
    getSession() {
      throw new Error("recent conversation should be skipped");
    },
  };
}
