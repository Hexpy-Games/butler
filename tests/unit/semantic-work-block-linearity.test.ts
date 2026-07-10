import { expect, test } from "bun:test";
import { createAgentTurnEvent, progressRowFromTurnEvent } from "../../packages/butler-agent/src/agent/events/turn-events.ts";
import { normalizeProgressSummaryRow } from "../../packages/butler-agent/src/gateways/app/domain/progress-summary/progress-row-normalizer.ts";
import { dedupeProgressRows } from "../../packages/butler-agent/src/gateways/app/domain/progress-summary/progress-row-merge.ts";
import { workBlocksFromTerminalProgressRows } from "../../packages/butler-agent/src/gateways/app/domain/sessions/session-work-blocks.ts";
import { workBlocksFromProgressRows } from "../../packages/butler-app/client/ui/src/app/utils.ts";

const sharedDecision = {
  decisionSummary: "관련 파일을 확인합니다.",
  decisionRationale: "관찰 결과에 따라 다음 작은 단계를 선택합니다.",
  decisionNextStep: "파일을 읽고 결과를 확인합니다.",
  decisionSource: "assistant-authored",
};

test("typed identifiers survive the public event and progress protocol projection", () => {
  const event = createAgentTurnEvent({
    sessionId: "butler/main",
    turnId: "turn-linear",
    sessionSequence: 1,
    turnSequence: 1,
    kind: "tool.started",
    payload: {
      toolCallId: "tool-a",
      toolName: "Read",
      inputLabel: "a.ts",
      safeLabel: "Read: a.ts",
      activityKind: "read",
      workBlockId: "turn-linear:contract-a:block:1",
      workBlockLabel: "첫 번째 파일을 확인합니다.",
      contractId: "contract-a",
      workstreamId: "workstream-a",
      semanticBlockId: "contract-a:block:1",
      ...sharedDecision,
    },
  });

  const projected = progressRowFromTurnEvent(event);
  expect(projected).toMatchObject({
    work_contract_id: "contract-a",
    work_stream_id: "workstream-a",
    semantic_block_id: "contract-a:block:1",
  });
  expect(normalizeProgressSummaryRow(projected!)).toMatchObject({
    work_contract_id: "contract-a",
    work_stream_id: "workstream-a",
    semantic_block_id: "contract-a:block:1",
  });
});

test("completed semantic blocks stay immutable when a later decision repeats the same text", () => {
  const rows = [
    blockRow("block-1-start", "work-1", "contract-a:block:1", "running"),
    toolRow("tool-1", "work-1", "contract-a:block:1", "delivered"),
    blockRow("block-1-complete", "work-1", "contract-a:block:1", "delivered"),
    blockRow("block-2-start", "work-2", "contract-a:block:2", "running"),
    toolRow("tool-2", "work-2", "contract-a:block:2", "running"),
  ].map(normalizeProgressSummaryRow);

  const deduped = dedupeProgressRows(rows);
  const serverBlocks = workBlocksFromTerminalProgressRows(deduped);
  expect(serverBlocks.map((block) => ({ id: block.id, state: block.state }))).toEqual([
    { id: "work-1", state: "delivered" },
    { id: "work-2", state: "running" },
  ]);
  expect(serverBlocks[0]?.rows.map((row) => row.tool_call_id)).toEqual(["tool-1"]);
  expect(serverBlocks[1]?.rows.map((row) => row.tool_call_id)).toEqual(["tool-2"]);

  const appBlocks = workBlocksFromProgressRows(deduped);
  expect(appBlocks.map((block) => ({ id: block.id, state: block.state }))).toEqual([
    { id: "work-1", state: "delivered" },
    { id: "work-2", state: "running" },
  ]);
  expect(appBlocks[0]?.rows.map((row) => row.tool_call_id)).toEqual(["tool-1"]);
  expect(appBlocks[1]?.rows.map((row) => row.tool_call_id)).toEqual(["tool-2"]);
});

function blockRow(id: string, workBlockId: string, semanticBlockId: string, state: string) {
  return {
    id,
    kind: "work_block",
    safe_label: "관련 파일을 확인합니다.",
    state,
    work_block_id: workBlockId,
    work_block_label: "관련 파일을 확인합니다.",
    work_contract_id: "contract-a",
    work_stream_id: "workstream-a",
    semantic_block_id: semanticBlockId,
    work_decision_summary: sharedDecision.decisionSummary,
    work_decision_rationale: sharedDecision.decisionRationale,
    work_decision_next_step: sharedDecision.decisionNextStep,
    work_decision_source: sharedDecision.decisionSource,
  };
}

function toolRow(id: string, workBlockId: string, semanticBlockId: string, state: string) {
  return {
    id,
    kind: "read",
    safe_label: "Read: a.ts",
    state,
    safe_tool_name: "Read",
    safe_input_label: "a.ts",
    tool_call_id: id,
    work_block_id: workBlockId,
    work_block_label: "관련 파일을 확인합니다.",
    work_contract_id: "contract-a",
    work_stream_id: "workstream-a",
    semantic_block_id: semanticBlockId,
    work_decision_summary: sharedDecision.decisionSummary,
    work_decision_rationale: sharedDecision.decisionRationale,
    work_decision_next_step: sharedDecision.decisionNextStep,
    work_decision_source: sharedDecision.decisionSource,
  };
}
