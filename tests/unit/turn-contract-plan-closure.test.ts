import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  compileTurnContract,
  evaluateTurnContractPlanClosure,
  TURN_CONTRACT_DECISION_SCHEMA,
  TURN_EVIDENCE_RECEIPT_SCHEMA,
  TurnContractStore,
  type TurnEvidenceReceipt,
} from "../../packages/butler-agent/src/agent/turn/turn-contract.ts";
import {
  activateTurnContract,
} from "../../packages/butler-agent/src/agent/turn/native/turn-runner/turn-contract-runtime.ts";
import type { ToolSurfacePromptController } from "../../packages/butler-agent/src/agent/turn/tool-surface-prompt-controller.ts";
import { WorkStreamPlanStore } from "../../packages/butler-agent/src/agent/work/work-stream-plan-store.ts";
import { WorkStreamStore } from "../../packages/butler-agent/src/agent/work/work-stream.ts";

const tempDirs: string[] = [];
afterEach(() => tempDirs.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

test("an explicit bound plan blocks evidence-only terminal delivery until retained work is complete", () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-plan-closure-"));
  tempDirs.push(butlerData);
  const decision = {
    schema_version: TURN_CONTRACT_DECISION_SCHEMA,
    decision_id: "decision-plan-closure",
    action: "start_work" as const,
    target_project_id: "project-sandy",
    deliverables: ["code_change" as const],
    public_title: "web.capture 구현",
    public_summary: "web.capture 구현을 완료합니다.",
    immediate_next_step: "구현 계획을 세우고 순서대로 실행합니다.",
  };
  const active = activateTurnContract({
    butlerData,
    contract: compileTurnContract({ decision }),
    decision,
    sessionId: "butler/sandy",
    chatId: "chat-sandy",
    projectId: "project-sandy",
    turnId: "turn-sandy",
    toolSurfaceController: { applyTurnMetadata() {} } as unknown as ToolSurfacePromptController,
  });
  const streams = new WorkStreamStore(butlerData);
  const stream = streams.read(active.contract.target_workstream_id!)!;
  const plans = new WorkStreamPlanStore(butlerData);
  const amended = plans.amend({
    workstreamId: stream.id,
    contractId: active.contract.contract_id,
    expectedGeneration: stream.record_generation ?? 1,
    items: [{
      id: "implement",
      content: "web.capture를 구현합니다.",
      active_form: "web.capture를 구현하는 중입니다.",
      status: "in_progress",
      phase: "execution",
    }, {
      id: "report",
      content: "결과를 보고합니다.",
      active_form: "결과를 보고하는 중입니다.",
      status: "pending",
      phase: "reporting",
      blocked_by: ["implement"],
    }],
  });
  expect(amended.ok).toBe(true);

  const store = new TurnContractStore(butlerData);
  const contract = store.read(active.contract.contract_id)!;
  const obligation = contract.required_evidence[0]!;
  const receipt: TurnEvidenceReceipt = {
    schema_version: TURN_EVIDENCE_RECEIPT_SCHEMA,
    receipt_id: "receipt-partial-code-change",
    contract_id: contract.contract_id,
    obligation_id: obligation.obligation_id,
    deliverable: obligation.deliverable,
    target_kind: obligation.target_kind,
    target_id: obligation.target_id,
    obligation_generation: obligation.generation,
    verified: true,
    item_ids: ["src/tools/web-capture.ts"],
    producer: "workspace",
    evidence_class: "durable_diff",
    created_at: new Date(0).toISOString(),
  };
  const withEvidence = store.recordEvidence(receipt);

  expect(withEvidence.state).toBe("executing");
  expect(evaluateTurnContractPlanClosure({ butlerData, contract: withEvidence })).toMatchObject({
    status: "incomplete",
    open_items: [{ id: "implement", status: "in_progress", phase: "execution" }],
  });
  expect(() => store.recordTerminalDelivery({
    contractId: withEvidence.contract_id,
    terminalState: "delivered",
    expectedGeneration: withEvidence.generation,
  })).toThrow("turn_contract_plan_incomplete");

  const currentStream = streams.read(stream.id)!;
  const completed = plans.amend({
    workstreamId: stream.id,
    contractId: contract.contract_id,
    expectedGeneration: currentStream.record_generation ?? 1,
    items: [{
      id: "implement",
      content: "web.capture를 구현합니다.",
      active_form: "web.capture를 구현하는 중입니다.",
      status: "completed",
      phase: "execution",
    }, {
      id: "report",
      content: "결과를 보고합니다.",
      active_form: "결과를 보고하는 중입니다.",
      status: "pending",
      phase: "reporting",
      blocked_by: ["implement"],
    }],
  });
  expect(completed.ok).toBe(true);
  expect(evaluateTurnContractPlanClosure({ butlerData, contract: withEvidence })).toEqual({ status: "satisfied", open_items: [] });
  expect(store.recordTerminalDelivery({
    contractId: withEvidence.contract_id,
    terminalState: "delivered",
    expectedGeneration: withEvidence.generation,
  }).contract.state).toBe("delivered");
});

test("the runtime opening placeholder does not over-gate a simple execution contract", () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-plan-placeholder-"));
  tempDirs.push(butlerData);
  const decision = {
    schema_version: TURN_CONTRACT_DECISION_SCHEMA,
    decision_id: "decision-placeholder",
    action: "start_work" as const,
    deliverables: ["code_change" as const],
    public_summary: "Apply one small change.",
  };
  const active = activateTurnContract({
    butlerData,
    contract: compileTurnContract({ decision }),
    decision,
    sessionId: "butler/simple",
    turnId: "turn-simple",
    toolSurfaceController: { applyTurnMetadata() {} } as unknown as ToolSurfacePromptController,
  });

  expect(evaluateTurnContractPlanClosure({ butlerData, contract: active.contract }))
    .toEqual({ status: "not_required", open_items: [] });
});
