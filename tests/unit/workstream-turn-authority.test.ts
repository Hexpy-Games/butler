import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createWorkTrackingToolHandlers } from "../../packages/butler-agent/src/agent/tools/work-tracking/shared.ts";
import {
  compileTurnContract,
  TURN_CONTRACT_DECISION_SCHEMA,
  type TurnContractDecision,
} from "../../packages/butler-agent/src/agent/turn/turn-contract.ts";
import { activateTurnContract } from "../../packages/butler-agent/src/agent/turn/native/turn-runner/turn-contract-runtime.ts";
import type { ToolSurfacePromptController } from "../../packages/butler-agent/src/agent/turn/tool-surface-prompt-controller.ts";
import { TodoListStore } from "../../packages/butler-agent/src/agent/work/todo-list.ts";
import { WorkStreamStore } from "../../packages/butler-agent/src/agent/work/work-stream.ts";

let data = "";

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), "butler-workstream-authority-"));
});

afterEach(() => {
  rmSync(data, { recursive: true, force: true });
});

test("start_work binds one claimed WorkStream and amends only its plan", async () => {
  const decision = startDecision();
  const active = activateTurnContract({
    butlerData: data,
    contract: compileTurnContract({ decision }),
    decision,
    sessionId: "butler/sandy",
    chatId: "chat-sandy",
    projectId: "sandy-bot",
    turnId: "turn-start",
    toolSurfaceController: fakeToolSurfaceController(),
  });
  const workStreamId = active.contract.target_workstream_id;
  expect(workStreamId).toBeTruthy();
  const streams = new WorkStreamStore(data);
  const todos = new TodoListStore(data);
  const claimed = streams.read(workStreamId!);
  expect(claimed).toMatchObject({
    active_contract_id: active.contract.contract_id,
    owner_session_id: "butler/sandy",
    origin_chat_id: "chat-sandy",
    project_id: "sandy-bot",
  });

  const handlers = createWorkTrackingToolHandlers({
    butlerData: data,
    sessionId: "butler/sandy",
    originChatId: "chat-sandy",
    projectId: "sandy-bot",
    turnId: "turn-start",
    todoListStore: todos,
    workStreamStore: streams,
    activeWorkStreamBinding: () => ({
      contractId: active.contract.contract_id,
      workStreamId: workStreamId!,
    }),
  });
  const result = await handlers.update_todo_list({ args: {
    list_id: "main",
    title: "Sandy web capture 구현",
    todos: [{
      id: "spec",
      content: "web.capture spec을 갱신합니다.",
      active_form: "web.capture spec을 갱신하는 중입니다.",
      status: "in_progress",
      phase: "planning",
    }, {
      id: "implement",
      content: "capture 구현을 완료합니다.",
      active_form: "capture 구현을 진행하는 중입니다.",
      status: "pending",
      phase: "execution",
    }],
  } }) as Record<string, unknown>;

  expect(result).toMatchObject({
    ok: true,
    list_id: claimed!.todo_list_id,
    work_stream: {
      id: workStreamId,
      active_contract_id: active.contract.contract_id,
      plan_revision: 2,
    },
    plan_amendment_receipt: {
      contract_id: active.contract.contract_id,
      workstream_id: workStreamId,
      revision: 2,
    },
  });
  expect(streams.list({ sessionId: "butler/sandy", includeTerminal: true })).toHaveLength(1);
});

test("bound WorkStream rejects todo and state mutations aimed at another stream", async () => {
  const decision = startDecision("decision-authority-mismatch");
  const active = activateTurnContract({
    butlerData: data,
    contract: compileTurnContract({ decision }),
    decision,
    sessionId: "butler/sandy",
    chatId: "chat-sandy",
    projectId: "sandy-bot",
    turnId: "turn-resume",
    toolSurfaceController: fakeToolSurfaceController(),
  });
  const workStreamId = active.contract.target_workstream_id!;
  const handlers = createWorkTrackingToolHandlers({
    butlerData: data,
    sessionId: "butler/sandy",
    originChatId: "chat-sandy",
    projectId: "sandy-bot",
    turnId: "turn-resume",
    todoListStore: new TodoListStore(data),
    workStreamStore: new WorkStreamStore(data),
    activeWorkStreamBinding: () => ({ contractId: active.contract.contract_id, workStreamId }),
  });

  await expect(handlers.update_todo_list({ args: {
    list_id: "unrelated-list",
    todos: [{
      id: "other",
      content: "다른 작업을 수행합니다.",
      active_form: "다른 작업을 수행하는 중입니다.",
      status: "in_progress",
    }],
  } })).rejects.toThrow("workstream_contract_todo_mismatch");
  await expect(handlers.update_work_stream_state({ args: {
    work_stream_id: "unrelated-stream",
    state: "paused",
  } })).rejects.toThrow("workstream_contract_target_mismatch");
  expect(new WorkStreamStore(data).read(workStreamId)?.active_contract_id)
    .toBe(active.contract.contract_id);
});

function startDecision(id = "decision-start-authority"): TurnContractDecision {
  return {
    schema_version: TURN_CONTRACT_DECISION_SCHEMA,
    decision_id: id,
    action: "start_work",
    target_project_id: "sandy-bot",
    deliverables: ["code_change", "validation", "final_report"],
    public_title: "Sandy web capture 구현",
    public_summary: "Sandy web capture 구현과 검증을 완료합니다.",
    public_rationale: "사용자가 durable 구현 결과를 요청했습니다.",
    immediate_next_step: "기존 구조를 확인하고 구현 plan을 갱신합니다.",
  };
}

function fakeToolSurfaceController(): ToolSurfacePromptController {
  return {
    applyTurnMetadata() {},
  } as unknown as ToolSurfacePromptController;
}
