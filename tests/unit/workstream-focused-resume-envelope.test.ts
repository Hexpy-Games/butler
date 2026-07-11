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
import {
  buildWorkStreamResumeDecisionEnvelope,
  turnMetadataWithResumeDecisionPolicy,
} from "../../packages/butler-agent/src/agent/turn/workstream-resume-decision-envelope.ts";
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
  new WorkStreamStore(tempDir).link({
    id: stream.id,
    plannedTaskIds: ["execute"],
    now: new Date("2026-07-03T00:02:00.000Z"),
  });
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
    turnMetadata: { workstreamResume: { action: "resume", workStreamId: stream.id } },
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
  expect(envelope?.prompt).toContain("Tracking Mode: ledger");
  expect(envelope?.prompt).toContain("Closeout Strategy: ledger");
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

test("focused resume envelope treats unlinked project WorkStreams as local tracking", () => {
  const stream = createRecoverableStream();
  writeProjectLedgerIndex({
    projectId: "butler",
    records: [
      {
        id: "execute",
        kind: "task",
        title: "Ledger record should not hydrate without a link",
        status: "in_progress",
        path: "project-ledger/projects/butler/work/W/tasks/execute.md",
      },
    ],
  });

  const selection = selectWorkStreamCheckpointResume({
    butlerData: tempDir,
    sessionId: "butler/session",
    projectId: "butler",
    turnMetadata: { workstreamResume: { action: "resume", workStreamId: stream.id } },
  });
  const envelope = buildFocusedResumeEnvelope({
    butlerData: tempDir,
    selection,
    currentUserText: "계속 진행해",
  });
  const turnMetadata = turnMetadataWithFocusedResumePolicy({
    tracking_mode: "ledger",
    runtime_phase: "closeout_planned",
    validation_state: "validation_passed",
    requiredNativeTools: ["project_ledger_task_complete"],
    requiredNativeToolProfiles: ["project-lifecycle"],
  }, envelope);
  const toolNames = selectInitialToolsFromSurfaceController({
    role: "butler",
    message: "계속 진행해",
    sessionMetadata: { projectId: "butler" },
    turnMetadata,
    providerCapabilities: {
      supportsToolCalls: true,
      supportsStreaming: true,
    },
  }).toolNames;

  expect(envelope?.checkpoint.trackingMode).toBe("ledger");
  expect(envelope?.checkpoint.closeoutStrategy).toBe("ledger");
  expect(envelope?.prompt).toContain("Tracking Mode: ledger");
  expect(envelope?.prompt).toContain("Closeout Strategy: ledger");
  expect(envelope?.requiredNativeTools).toEqual(expect.arrayContaining([
    "project_ledger_status",
    "project_ledger_show",
  ]));
  expect(turnMetadata).toMatchObject({
    tracking_mode: "ledger",
    closeout_strategy: "ledger",
    runtimePolicy: {
      tracking_mode: "ledger",
      closeout_strategy: "ledger",
    },
    focusedResume: {
      trackingMode: "ledger",
      closeoutStrategy: "ledger",
    },
  });
  expect(turnMetadata?.requiredNativeTools).toEqual(expect.arrayContaining([
    "project_ledger_task_complete",
    "project_ledger_status",
  ]));
  expect(turnMetadata?.requiredNativeToolProfiles).toContain("project-lifecycle");
  expect(toolNames).toEqual(expect.arrayContaining([
    "project_ledger_status",
    "inspect_project_status",
    "query_project_work",
  ]));
});

test("ordinary user turns get a model decision envelope instead of focused resume", () => {
  const stream = createRecoverableStream();
  const selection = selectWorkStreamCheckpointResume({
    butlerData: tempDir,
    sessionId: "butler/session",
    projectId: "butler",
    userText: "완전히 다른 작업을 해줘",
  });
  const focused = buildFocusedResumeEnvelope({
    butlerData: tempDir,
    selection,
    currentUserText: "완전히 다른 작업을 해줘",
  });
  const decision = buildWorkStreamResumeDecisionEnvelope({
    selection,
    currentUserText: "완전히 다른 작업을 해줘",
  });
  const turnMetadata = turnMetadataWithResumeDecisionPolicy({}, decision);
  const toolNames = selectInitialToolsFromSurfaceController({
    role: "butler",
    message: "완전히 다른 작업을 해줘",
    sessionMetadata: { projectId: "butler" },
    turnMetadata,
    providerCapabilities: {
      supportsToolCalls: true,
      supportsStreaming: true,
    },
  }).toolNames;

  expect(selection).toMatchObject({
    state: "resume_candidate_presented",
    reason: "model_decision_required",
    candidates: [expect.objectContaining({ id: stream.id })],
  });
  expect(focused).toBeNull();
  expect(decision?.prompt).toContain("## WorkStream Continuation Decision Envelope");
  expect(decision?.prompt).toContain("Current User Instruction:\n완전히 다른 작업을 해줘");
  expect(decision?.prompt).toContain("Tracking Mode: ledger");
  expect(decision?.prompt).toContain("If the current instruction asks for unrelated work");
  expect(decision?.prompt).not.toContain("Continue this selected WorkStream before broad validation");
  expect(decision?.requiredNativeToolProfiles).toContain("project");
  expect(decision?.requiredNativeTools).toEqual(expect.arrayContaining([
    "project_ledger_status",
    "project_ledger_show",
  ]));
  expect(toolNames).toEqual(expect.arrayContaining([
    "list_work_streams",
    "update_work_stream_state",
    "update_todo_list",
    "run_command",
    "read_file",
    "write_file",
  ]));
  expect(toolNames).toEqual(expect.arrayContaining([
    "query_project_work",
    "inspect_project_status",
    "project_ledger_status",
  ]));
});

test("candidate decision envelope keeps workspace tools for planning-phase work with executable pending todos", () => {
  const stream = createPlanningThenExecutableRecoverableStream();
  const selection = selectWorkStreamCheckpointResume({
    butlerData: tempDir,
    sessionId: "butler/session",
    projectId: "butler",
    userText: "계속해서 진행해줄래",
  });
  const decision = buildWorkStreamResumeDecisionEnvelope({
    selection,
    currentUserText: "계속해서 진행해줄래",
  });
  const turnMetadata = turnMetadataWithResumeDecisionPolicy({}, decision);
  const toolNames = selectInitialToolsFromSurfaceController({
    role: "butler",
    message: "계속해서 진행해줄래",
    sessionMetadata: { projectId: "butler" },
    turnMetadata,
    providerCapabilities: {
      supportsToolCalls: true,
      supportsStreaming: true,
    },
  }).toolNames;

  expect(selection).toMatchObject({
    state: "resume_candidate_presented",
    candidates: [expect.objectContaining({
      id: stream.id,
      checkpoint: expect.objectContaining({
        currentPhase: "planning",
        activeItems: expect.arrayContaining([
          expect.objectContaining({ id: "select-ledger-task", phase: "planning", status: "in_progress" }),
          expect.objectContaining({ id: "implement-task", phase: "execution", status: "pending" }),
        ]),
      }),
    })],
  });
  expect(decision?.requiredNativeToolProfiles).toEqual(expect.arrayContaining(["workspace"]));
  expect(decision?.requiredNativeToolProfiles).toContain("project");
  expect(toolNames).toEqual(expect.arrayContaining([
    "run_command",
    "read_file",
    "write_file",
    "grep_files",
    "read_tool_evidence_artifact",
    "read_tool_output_artifact",
  ]));
  expect(toolNames).toEqual(expect.arrayContaining([
    "project_ledger_status",
    "query_project_work",
  ]));
});

test("candidate decision envelope sees executable pending todos beyond active item preview", () => {
  const stream = createTruncatedPlanningPreviewRecoverableStream();
  const selection = selectWorkStreamCheckpointResume({
    butlerData: tempDir,
    sessionId: "butler/session",
    projectId: "butler",
    userText: "계속해서 진행해줄래",
  });
  const decision = buildWorkStreamResumeDecisionEnvelope({
    selection,
    currentUserText: "계속해서 진행해줄래",
  });
  const turnMetadata = turnMetadataWithResumeDecisionPolicy({}, decision);
  const toolNames = selectInitialToolsFromSurfaceController({
    role: "butler",
    message: "계속해서 진행해줄래",
    sessionMetadata: { projectId: "butler" },
    turnMetadata,
    providerCapabilities: {
      supportsToolCalls: true,
      supportsStreaming: true,
    },
  }).toolNames;

  expect(selection.state).toBe("resume_candidate_presented");
  const candidate = selection.candidates[0];
  expect(candidate).toBeDefined();
  const checkpoint = candidate?.checkpoint;
  expect(candidate?.id).toBe(stream.id);
  expect(checkpoint?.currentPhase).toBe("planning");
  expect(checkpoint?.openItemPhaseCounts).toEqual(expect.objectContaining({ planning: 8, execution: 1 }));
  const activeItems = checkpoint?.activeItems ?? [];
  expect(activeItems).toHaveLength(8);
  expect(activeItems.map((item) => item.id)).not.toContain("execute-after-preview");
  expect(decision?.requiredNativeToolProfiles).toEqual(expect.arrayContaining(["workspace"]));
  expect(decision?.requiredNativeToolProfiles).toContain("project");
  expect(toolNames).toEqual(expect.arrayContaining([
    "run_command",
    "read_file",
    "write_file",
    "grep_files",
  ]));
  expect(toolNames).toContain("project_ledger_status");
});

test("focused resume prompt excludes broad recent conversation and prompt-context work sections", () => {
  const selection = selectWorkStreamCheckpointResume({
    butlerData: tempDir,
    sessionId: "butler/session",
    projectId: "butler",
  });
  expect(selection.state).toBe("fresh_turn");

  const stream = createRecoverableStream();
  const resumed = selectWorkStreamCheckpointResume({
    butlerData: tempDir,
    sessionId: "butler/session",
    projectId: "butler",
    userText: "ㅇㅇ",
    turnMetadata: { workstreamResume: { action: "resume", workStreamId: stream.id } },
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
  expect(normalized.resumeDecisionEnvelopeChars).toBe(0);
  expect(sections).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "focused_resume_envelope" }),
  ]));
});

test("model decision prompt keeps recent conversation and tracks decision-envelope usage", () => {
  const selection = selectWorkStreamCheckpointResume({
    butlerData: tempDir,
    sessionId: "butler/session",
    projectId: "butler",
    userText: "다른 작업을 시작해줘",
  });
  expect(selection.state).toBe("fresh_turn");

  createRecoverableStream();
  const candidateSelection = selectWorkStreamCheckpointResume({
    butlerData: tempDir,
    sessionId: "butler/session",
    projectId: "butler",
    userText: "다른 작업을 시작해줘",
  });
  const decision = buildWorkStreamResumeDecisionEnvelope({
    selection: candidateSelection,
    currentUserText: "다른 작업을 시작해줘",
  });
  expect(decision).not.toBeNull();

  const normalized = normalizeTurnPrompt(runtimeTurnInput({
    promptContext: [
      "## Stable Context",
      "KEEP_CONTEXT_SENTINEL",
      "## Active Work State",
      "ACTIVE_WORK_CONTEXT_SENTINEL",
    ].join("\n"),
    text: "다른 작업을 시작해줘",
  }), {
    butlerData: tempDir,
    recentConversationTokenBudget: 1_000,
    resumeDecisionEnvelope: decision!.prompt,
    conversationReader: emptyConversationReader(),
  });
  const sections = promptUsageSectionsFromPrompt(normalized);

  expect(normalized.prompt).toContain("## WorkStream Continuation Decision Envelope");
  expect(normalized.prompt).toContain("ACTIVE_WORK_CONTEXT_SENTINEL");
  expect(normalized.focusedResumeEnvelopeChars).toBe(0);
  expect(normalized.resumeDecisionEnvelopeChars).toBeGreaterThan(0);
  expect(sections).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "resume_decision_envelope" }),
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

function createPlanningThenExecutableRecoverableStream(): WorkStreamRecord {
  const todoView = new TodoListStore(tempDir).update({
    listId: "sandy-continue-2026-07-03",
    title: "Sandy remaining Ledger work",
    items: [
      todo({ id: "select-ledger-task", content: "Select the next Project Ledger task", status: "in_progress", phase: "planning" }),
      todo({ id: "implement-task", content: "Implement the selected task", status: "pending", phase: "execution" }),
      todo({ id: "validate-task", content: "Run validation and review", status: "pending", phase: "review" }),
      todo({ id: "report-task", content: "Report and close Ledger state", status: "pending", phase: "reporting" }),
    ],
    now: new Date("2026-07-03T00:00:00.000Z"),
  });
  const stream = new WorkStreamStore(tempDir).updateFromTodoList({
    ownerSessionId: "butler/session",
    projectId: "butler",
    listId: todoView.list.list_id,
    title: "Sandy remaining Ledger work",
    items: todoView.list.items,
    now: new Date("2026-07-03T00:00:00.000Z"),
  });
  return new WorkStreamStore(tempDir).transition({
    id: stream.id,
    state: "recoverable",
    statusNote: "Resume from git status and partial changes when workspace tools are callable.",
    now: new Date("2026-07-03T00:01:00.000Z"),
  });
}

function createTruncatedPlanningPreviewRecoverableStream(): WorkStreamRecord {
  const planningItems = Array.from({ length: 8 }, (_, index) => todo({
    id: `planning-${index + 1}`,
    content: `Planning item ${index + 1}`,
    status: index === 0 ? "in_progress" : "pending",
    phase: "planning",
  }));
  const todoView = new TodoListStore(tempDir).update({
    listId: "sandy-truncated-preview-2026-07-03",
    title: "Sandy long planning list",
    items: [
      ...planningItems,
      todo({ id: "execute-after-preview", content: "Execute after preview", status: "pending", phase: "execution" }),
    ],
    now: new Date("2026-07-03T00:00:00.000Z"),
  });
  const stream = new WorkStreamStore(tempDir).updateFromTodoList({
    ownerSessionId: "butler/session",
    projectId: "butler",
    listId: todoView.list.list_id,
    title: "Sandy long planning list",
    items: todoView.list.items,
    now: new Date("2026-07-03T00:00:00.000Z"),
  });
  return new WorkStreamStore(tempDir).transition({
    id: stream.id,
    state: "recoverable",
    statusNote: "Resume long planning list with execution work beyond the checkpoint preview.",
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

function emptyConversationReader(): any {
  return {
    getSession() {
      return { id: "butler/session" };
    },
    getSessionByGatewayBinding() {
      return null;
    },
    readPromptMaterial() {
      return {
        summaries: [],
        semantic_tail: [],
      };
    },
  };
}
