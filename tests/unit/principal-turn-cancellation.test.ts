import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { cancelPersistedRuntimeTurn } from "../../packages/butler-agent/src/agent/turn/principal-turn-cancellation.ts";
import {
  principalTurnCancellationMarkerPath,
  principalTurnCancellationRecorded,
  recordPrincipalTurnCancellation,
  refreshPrincipalTurnAbortSignal,
  registerPrincipalTurnAbortController,
} from "../../packages/butler-agent/src/agent/turn/principal-turn-cancellation-registry.ts";
import { throwIfRuntimeTurnAborted } from "../../packages/butler-agent/src/agent/turn/native/policy/turn-errors.ts";
import {
  compileTurnContract,
  TURN_CONTRACT_DECISION_SCHEMA,
  TurnContractStore,
} from "../../packages/butler-agent/src/agent/turn/turn-contract.ts";
import {
  persistTurnContextAtom,
  readTurnContextAtom,
} from "../../packages/butler-agent/src/agent/turn/turn-continuation-context.ts";
import { TodoListStore } from "../../packages/butler-agent/src/agent/work/todo-list.ts";
import { WorkStreamClaimStore } from "../../packages/butler-agent/src/agent/work/work-stream-claim-store.ts";
import { WorkStreamStore } from "../../packages/butler-agent/src/agent/work/work-stream.ts";

const tempDirs: string[] = [];
afterEach(() => tempDirs.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

test("principal turn cancellation closes the typed contract and removes its continuation", () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-principal-cancel-"));
  tempDirs.push(butlerData);
  const sessionId = "butler/app-project-a";
  const turnId = "turn-principal-cancel";
  const store = new TurnContractStore(butlerData);
  const created = store.create(compileTurnContract({
    decision: {
      schema_version: TURN_CONTRACT_DECISION_SCHEMA,
      decision_id: "decision-principal-cancel",
      action: "start_work",
      target_project_id: "project-a",
      deliverables: ["code_change"],
      public_summary: "Apply the requested change.",
    },
  }));
  const continuing = store.recordContinuationCommit({
    contractId: created.contract_id,
    commitId: "checkpoint-1",
    expectedGeneration: created.generation,
  });
  persistTurnContextAtom({
    butlerData,
    sessionId,
    turnId,
    state: "continuing",
    sourceErrorCode: "provider_rate_limited",
    reason: "retry later",
    contractId: continuing.contract_id,
  });

  cancelPersistedRuntimeTurn({ butlerData, turnId });

  expect(store.read(continuing.contract_id)).toMatchObject({
    state: "cancelled",
    generation: continuing.generation + 1,
    terminal_delivery_keys: [expect.stringContaining("delivery-")],
  });
  expect(readTurnContextAtom({ butlerData, sessionId, turnId })).toBeNull();
  expect(() => store.recordContinuationCommit({
    contractId: continuing.contract_id,
    commitId: "checkpoint-after-cancel",
    expectedGeneration: continuing.generation + 1,
  })).toThrow("terminal_immutable");
});

test("principal cancellation resolves an in-process contract through its WorkStream binding", () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-principal-cancel-"));
  tempDirs.push(butlerData);
  const sessionId = "butler/app-project-a";
  const turnId = "turn-in-process-cancel";
  const todo = new TodoListStore(butlerData).update({
    listId: "in-process-plan",
    title: "In-process work",
    items: [{
      id: "implement",
      content: "Apply the requested change.",
      active_form: "Applying the requested change.",
      status: "in_progress",
      phase: "execution",
      priority: "normal",
    }],
  });
  const streams = new WorkStreamStore(butlerData);
  const stream = streams.updateFromTodoList({
    id: "work-in-process-cancel",
    ownerSessionId: sessionId,
    originChatId: "project-a",
    projectId: "project-a",
    listId: todo.list.list_id,
    title: todo.list.title,
    lastUserTurnId: turnId,
    items: todo.list.items,
  });
  const contracts = new TurnContractStore(butlerData);
  const contract = contracts.create(compileTurnContract({
    decision: {
      schema_version: TURN_CONTRACT_DECISION_SCHEMA,
      decision_id: "decision-in-process-cancel",
      action: "start_work",
      target_project_id: "project-a",
      target_workstream_id: stream.id,
      deliverables: ["code_change"],
      public_summary: "Apply the requested change.",
    },
  }));
  const claim = new WorkStreamClaimStore(butlerData).claim({
    contract,
    workstreamId: stream.id,
    sessionId,
    chatId: "project-a",
    projectId: "project-a",
    turnId,
    expectedGeneration: stream.record_generation ?? 1,
  });
  expect(claim.ok).toBe(true);
  expect(readTurnContextAtom({ butlerData, sessionId, turnId })).toBeNull();

  cancelPersistedRuntimeTurn({ butlerData, turnId });

  expect(contracts.read(contract.contract_id)?.state).toBe("cancelled");
  expect(streams.read(stream.id)).toMatchObject({
    state: "cancelled",
    active_contract_id: null,
  });
  expect(contracts.listNonTerminal().map((item) => item.contract_id))
    .not.toContain(contract.contract_id);
});

test("principal cancellation tombstone aborts active and restarted turn controllers", () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-principal-cancel-"));
  tempDirs.push(butlerData);
  const turnId = "turn-controller-cancel";
  const activeController = new AbortController();
  const unregister = registerPrincipalTurnAbortController({
    butlerData,
    turnId,
    controller: activeController,
  });

  recordPrincipalTurnCancellation({ butlerData, turnId });

  expect(activeController.signal.aborted).toBe(true);
  expect(principalTurnCancellationRecorded({ butlerData, turnId })).toBe(true);
  const markerPath = principalTurnCancellationMarkerPath({ butlerData, turnId });
  expect(markerPath).not.toContain(turnId);
  expect(readFileSync(markerPath, "utf8")).not.toContain(turnId);
  unregister();

  const restartedController = new AbortController();
  const unregisterRestarted = registerPrincipalTurnAbortController({
    butlerData,
    turnId,
    controller: restartedController,
  });
  expect(restartedController.signal.aborted).toBe(true);
  unregisterRestarted();
});

test("turn boundary refresh observes a cancellation written by another process", () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-principal-cancel-"));
  tempDirs.push(butlerData);
  const turnId = "turn-external-controller-cancel";
  const controller = new AbortController();
  const unregister = registerPrincipalTurnAbortController({
    butlerData,
    turnId,
    controller,
  });
  writeFileSync(
    principalTurnCancellationMarkerPath({ butlerData, turnId }),
    `${JSON.stringify({ schemaVersion: "butler.principal-turn-cancellation.v1" })}\n`,
    "utf8",
  );

  expect(() => throwIfRuntimeTurnAborted(controller.signal)).toThrow("Runtime turn was cancelled");
  expect(refreshPrincipalTurnAbortSignal(controller.signal)).toBe(true);
  expect(controller.signal.aborted).toBe(true);
  unregister();
});

test("turn controller file watcher observes cross-process cancellation while a call is in flight", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-principal-cancel-"));
  tempDirs.push(butlerData);
  const turnId = "turn-external-watcher-cancel";
  const controller = new AbortController();
  const unregister = registerPrincipalTurnAbortController({
    butlerData,
    turnId,
    controller,
  });
  const aborted = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("principal cancellation watcher timed out")),
      1_000,
    );
    controller.signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

  writeFileSync(
    principalTurnCancellationMarkerPath({ butlerData, turnId }),
    `${JSON.stringify({ schemaVersion: "butler.principal-turn-cancellation.v1" })}\n`,
    "utf8",
  );
  await aborted;

  expect(controller.signal.aborted).toBe(true);
  unregister();
});

test("completed turn registration is removed before a later cancellation record", () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-principal-cancel-"));
  tempDirs.push(butlerData);
  const turnId = "turn-completed-before-cancel";
  const controller = new AbortController();
  const unregister = registerPrincipalTurnAbortController({
    butlerData,
    turnId,
    controller,
  });

  unregister();
  unregister();
  recordPrincipalTurnCancellation({ butlerData, turnId });

  expect(controller.signal.aborted).toBe(false);
});
