import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  compileTurnContract,
  reconcileNonTerminalTurnContracts,
  TURN_CONTRACT_DECISION_SCHEMA,
  TurnContractStore,
} from "../../packages/butler-agent/src/agent/turn/turn-contract.ts";
import { persistTurnContextAtom } from "../../packages/butler-agent/src/agent/turn/turn-continuation-context.ts";

const tempDirs: string[] = [];
afterEach(() => tempDirs.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

test("restart preserves a continuing contract with its queryable context atom", () => {
  const data = tempData();
  const store = new TurnContractStore(data);
  const created = store.create(inspectContract());
  const executing = store.transitionState({
    contractId: created.contract_id,
    state: "executing",
    expectedGeneration: created.generation,
  });
  const commitId = persistTurnContextAtom({
    butlerData: data,
    sessionId: "butler/main",
    turnId: "turn-restart",
    state: "continuing",
    sourceErrorCode: "budget_rollover",
    reason: "Continue the same logical turn.",
  })!;
  const continuing = store.recordContinuationCommit({
    contractId: executing.contract_id,
    commitId,
    expectedGeneration: executing.generation,
  });

  expect(reconcileNonTerminalTurnContracts({ butlerData: data })).toEqual([{
    contractState: "continuing",
    action: "inspect",
    outcome: "continuation_preserved",
    code: "continuation_ready",
  }]);
  expect(store.read(continuing.contract_id)?.generation).toBe(continuing.generation);
});

test("restart fails closed when a continuing contract lost its durable checkpoint", () => {
  const data = tempData();
  const store = new TurnContractStore(data);
  const created = store.create(inspectContract());
  const executing = store.transitionState({
    contractId: created.contract_id,
    state: "executing",
    expectedGeneration: created.generation,
  });
  const continuing = store.recordContinuationCommit({
    contractId: executing.contract_id,
    commitId: "missing-continuation.json",
    expectedGeneration: executing.generation,
  });

  expect(reconcileNonTerminalTurnContracts({ butlerData: data })[0]).toMatchObject({
    outcome: "failed_system",
    code: "continuation_checkpoint_missing",
  });
  expect(store.read(continuing.contract_id)?.state).toBe("failed_system");
  expect(reconcileNonTerminalTurnContracts({ butlerData: data })).toEqual([]);
});

function inspectContract() {
  return compileTurnContract({
    decision: {
      schema_version: TURN_CONTRACT_DECISION_SCHEMA,
      decision_id: "decision-restart",
      action: "inspect",
      target_project_id: "butler",
      inspection_scope: "project",
      deliverables: ["status_report"],
      public_summary: "Inspect canonical status.",
    },
  });
}

function tempData(): string {
  const path = mkdtempSync(join(tmpdir(), "butler-turn-contract-recovery-"));
  tempDirs.push(path);
  return path;
}
