import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { cancelPersistedRuntimeTurn } from "../../packages/butler-agent/src/agent/turn/principal-turn-cancellation.ts";
import {
  sendCancelExecutionRequest,
  startPrincipalTurnCancellationServer,
} from "../../packages/butler-agent/src/agent/turn/principal-turn-cancellation-control.ts";
import {
  abortPrincipalTurnExecution,
  principalTurnCancellationRecorded,
  recordPrincipalTurnCancellation,
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
import { workStreamMutationLockPath } from "../../packages/butler-agent/src/agent/work/work-stream-mutation-authority.ts";
import { WorkStreamPlanStore } from "../../packages/butler-agent/src/agent/work/work-stream-plan-store.ts";
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
  if (!claim.ok) throw new Error("expected WorkStream claim");
  expect(readTurnContextAtom({ butlerData, sessionId, turnId })).toBeNull();

  cancelPersistedRuntimeTurn({ butlerData, turnId });

  expect(contracts.read(contract.contract_id)?.state).toBe("cancelled");
  const cancelledStream = streams.read(stream.id);
  expect(cancelledStream).toMatchObject({
    state: "cancelled",
    active_contract_id: null,
    claim_lease_expires_at: null,
  });
  const cancellationReceipt = cancelledStream?.active_claim_receipt_id
    ? new WorkStreamClaimStore(butlerData).readReceipt(cancelledStream.active_claim_receipt_id)
    : null;
  expect(cancellationReceipt).toMatchObject({
    operation: "cancel",
    outcome: "cancelled",
    contract_id: contract.contract_id,
    turn_id: turnId,
  });
  expect(new TodoListStore(butlerData).read(todo.list.list_id)?.items).toEqual([
    expect.objectContaining({ id: "implement", status: "cancelled" }),
  ]);
  expect(contracts.listNonTerminal().map((item) => item.contract_id))
    .not.toContain(contract.contract_id);

  new TodoListStore(butlerData).update({
    listId: todo.list.list_id,
    items: [{
      id: "implement",
      content: "Apply the requested change.",
      active_form: "Applying the requested change.",
      status: "in_progress",
      phase: "execution",
    }],
  });
  cancelPersistedRuntimeTurn({ butlerData, turnId });
  expect(new TodoListStore(butlerData).read(todo.list.list_id)?.items[0]?.status).toBe("cancelled");
});

test("principal cancellation closes a known contract before its WorkStream claim is installed", () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-principal-cancel-"));
  tempDirs.push(butlerData);
  const sessionId = "butler/app-project-preclaim";
  const turnId = "turn-principal-preclaim";
  const todo = new TodoListStore(butlerData).update({
    listId: "preclaim-plan",
    items: [{
      id: "opening",
      content: "Prepare the requested work.",
      active_form: "Preparing the requested work.",
      status: "in_progress",
      phase: "planning",
    }],
  });
  const streams = new WorkStreamStore(butlerData);
  const stream = streams.updateFromTodoList({
    id: "work-principal-preclaim",
    ownerSessionId: sessionId,
    originChatId: "project-preclaim",
    projectId: "project-preclaim",
    listId: todo.list.list_id,
    items: todo.list.items,
    lastUserTurnId: turnId,
  });
  const contracts = new TurnContractStore(butlerData);
  const contract = contracts.create(compileTurnContract({
    decision: {
      schema_version: TURN_CONTRACT_DECISION_SCHEMA,
      decision_id: "decision-principal-preclaim",
      action: "start_work",
      target_project_id: "project-preclaim",
      target_workstream_id: stream.id,
      deliverables: ["code_change"],
      public_summary: "Execute the requested work.",
    },
  }));

  cancelPersistedRuntimeTurn({
    butlerData,
    turnId,
    contractIds: [contract.contract_id],
  });

  expect(contracts.read(contract.contract_id)?.state).toBe("cancelled");
  expect(streams.read(stream.id)).toMatchObject({
    state: "cancelled",
    active_contract_id: null,
    claim_lease_expires_at: null,
  });
  expect(new TodoListStore(butlerData).read(todo.list.list_id)?.items[0]?.status).toBe("cancelled");
});

test("principal cancellation retries a transient WorkStream mutation-lock conflict", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-principal-cancel-"));
  tempDirs.push(butlerData);
  const sessionId = "butler/app-project-lock";
  const turnId = "turn-principal-lock-conflict";
  const todo = new TodoListStore(butlerData).update({
    listId: "lock-conflict-plan",
    items: [{
      id: "execute",
      content: "Execute the requested work.",
      active_form: "Executing the requested work.",
      status: "in_progress",
      phase: "execution",
    }],
  });
  const streams = new WorkStreamStore(butlerData);
  const stream = streams.updateFromTodoList({
    id: "work-principal-lock-conflict",
    ownerSessionId: sessionId,
    originChatId: "project-lock",
    projectId: "project-lock",
    listId: todo.list.list_id,
    items: todo.list.items,
    lastUserTurnId: turnId,
  });
  const contracts = new TurnContractStore(butlerData);
  const contract = contracts.create(compileTurnContract({
    decision: {
      schema_version: TURN_CONTRACT_DECISION_SCHEMA,
      decision_id: "decision-principal-lock-conflict",
      action: "start_work",
      target_project_id: "project-lock",
      target_workstream_id: stream.id,
      deliverables: ["code_change"],
      public_summary: "Execute the requested work.",
    },
  }));
  const claim = new WorkStreamClaimStore(butlerData).claim({
    contract,
    workstreamId: stream.id,
    sessionId,
    chatId: "project-lock",
    projectId: "project-lock",
    turnId,
    expectedGeneration: stream.record_generation ?? 1,
  });
  if (!claim.ok) throw new Error("expected WorkStream claim");

  const logPath = join(butlerData, "principal-cancel-lock-holder.jsonl");
  const holder = Bun.spawn({
    cmd: [
      process.execPath,
      join(process.cwd(), "tests", "support", "sqlite-lock-contender.ts"),
      workStreamMutationLockPath(butlerData, stream.id),
      logPath,
      "principal-cancel-holder",
      "140",
      "30000",
      butlerData,
    ],
    cwd: process.cwd(),
    stdout: "ignore",
    stderr: "inherit",
  });
  await waitForLockEntry(logPath);

  const startedAt = performance.now();
  cancelPersistedRuntimeTurn({ butlerData, turnId });
  const elapsedMs = performance.now() - startedAt;
  expect(await holder.exited).toBe(0);
  expect(elapsedMs).toBeGreaterThanOrEqual(75);
  expect(elapsedMs).toBeLessThan(500);
  expect(streams.read(stream.id)).toMatchObject({
    state: "cancelled",
    active_contract_id: null,
    claim_lease_expires_at: null,
  });
  expect(contracts.read(contract.contract_id)?.state).toBe("cancelled");
  expect(new TodoListStore(butlerData).read(todo.list.list_id)?.items[0]?.status).toBe("cancelled");
});

test("principal cancellation never publishes half-cancelled durable state after retry exhaustion", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-principal-cancel-"));
  tempDirs.push(butlerData);
  const sessionId = "butler/app-project-exhausted";
  const turnId = "turn-principal-lock-exhausted";
  const todo = new TodoListStore(butlerData).update({
    listId: "lock-exhausted-plan",
    items: [{
      id: "execute",
      content: "Execute the requested work.",
      active_form: "Executing the requested work.",
      status: "in_progress",
      phase: "execution",
    }],
  });
  const streams = new WorkStreamStore(butlerData);
  const stream = streams.updateFromTodoList({
    id: "work-principal-lock-exhausted",
    ownerSessionId: sessionId,
    originChatId: "project-exhausted",
    projectId: "project-exhausted",
    listId: todo.list.list_id,
    items: todo.list.items,
    lastUserTurnId: turnId,
  });
  const contracts = new TurnContractStore(butlerData);
  const contract = contracts.create(compileTurnContract({
    decision: {
      schema_version: TURN_CONTRACT_DECISION_SCHEMA,
      decision_id: "decision-principal-lock-exhausted",
      action: "start_work",
      target_project_id: "project-exhausted",
      target_workstream_id: stream.id,
      deliverables: ["code_change"],
      public_summary: "Execute the requested work.",
    },
  }));
  const claim = new WorkStreamClaimStore(butlerData).claim({
    contract,
    workstreamId: stream.id,
    sessionId,
    chatId: "project-exhausted",
    projectId: "project-exhausted",
    turnId,
    expectedGeneration: stream.record_generation ?? 1,
  });
  if (!claim.ok) throw new Error("expected WorkStream claim");
  persistTurnContextAtom({
    butlerData,
    sessionId,
    turnId,
    state: "continuing",
    sourceErrorCode: "provider_rate_limited",
    reason: "retry later",
    contractId: contract.contract_id,
  });

  const logPath = join(butlerData, "principal-cancel-lock-exhausted.jsonl");
  const holder = Bun.spawn({
    cmd: [
      process.execPath,
      join(process.cwd(), "tests", "support", "sqlite-lock-contender.ts"),
      workStreamMutationLockPath(butlerData, stream.id),
      logPath,
      "principal-cancel-exhausted-holder",
      "30000",
      "30000",
      butlerData,
    ],
    cwd: process.cwd(),
    stdout: "ignore",
    stderr: "inherit",
  });
  await waitForLockEntry(logPath);

  const startedAt = performance.now();
  expect(() => cancelPersistedRuntimeTurn({ butlerData, turnId }))
    .toThrow("principal_turn_cancellation_reconciliation_failed");
  expect(performance.now() - startedAt).toBeGreaterThanOrEqual(280);
  expect(streams.read(stream.id)).toMatchObject({
    state: "executing",
    active_contract_id: contract.contract_id,
  });
  expect(contracts.read(contract.contract_id)?.state).not.toBe("cancelled");
  expect(new TodoListStore(butlerData).read(todo.list.list_id)?.items[0]?.status).toBe("in_progress");
  expect(readTurnContextAtom({ butlerData, sessionId, turnId })).not.toBeNull();

  holder.kill("SIGKILL");
  await holder.exited;
  cancelPersistedRuntimeTurn({ butlerData, turnId });
  expect(streams.read(stream.id)).toMatchObject({
    state: "cancelled",
    active_contract_id: null,
    claim_lease_expires_at: null,
  });
  expect(contracts.read(contract.contract_id)?.state).toBe("cancelled");
  expect(new TodoListStore(butlerData).read(todo.list.list_id)?.items[0]?.status).toBe("cancelled");
  expect(readTurnContextAtom({ butlerData, sessionId, turnId })).toBeNull();
}, 30_000);

test("principal cancellation reads the current WorkStream generation after plan amendment", () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-principal-cancel-"));
  tempDirs.push(butlerData);
  const sessionId = "butler/app-project-generation";
  const turnId = "turn-principal-current-generation";
  const todo = new TodoListStore(butlerData).update({
    listId: "current-generation-plan",
    items: [{
      id: "opening",
      content: "Prepare the work.",
      active_form: "Preparing the work.",
      status: "in_progress",
      phase: "planning",
    }],
  });
  const streams = new WorkStreamStore(butlerData);
  const stream = streams.updateFromTodoList({
    id: "work-principal-current-generation",
    ownerSessionId: sessionId,
    originChatId: "project-generation",
    projectId: "project-generation",
    listId: todo.list.list_id,
    items: todo.list.items,
    lastUserTurnId: turnId,
  });
  const contracts = new TurnContractStore(butlerData);
  const contract = contracts.create(compileTurnContract({
    decision: {
      schema_version: TURN_CONTRACT_DECISION_SCHEMA,
      decision_id: "decision-principal-current-generation",
      action: "start_work",
      target_project_id: "project-generation",
      target_workstream_id: stream.id,
      deliverables: ["code_change"],
      public_summary: "Execute the amended plan.",
    },
  }));
  const claim = new WorkStreamClaimStore(butlerData).claim({
    contract,
    workstreamId: stream.id,
    sessionId,
    chatId: "project-generation",
    projectId: "project-generation",
    turnId,
    expectedGeneration: stream.record_generation ?? 1,
  });
  if (!claim.ok) throw new Error("expected WorkStream claim");
  const staleGeneration = claim.record.record_generation ?? 1;
  const amendment = new WorkStreamPlanStore(butlerData).amend({
    workstreamId: stream.id,
    contractId: contract.contract_id,
    expectedGeneration: staleGeneration,
    title: "Amended plan",
    items: [{
      id: "execute",
      content: "Execute the amended work.",
      active_form: "Executing the amended work.",
      status: "in_progress",
      phase: "execution",
    }],
  });
  if (!amendment.ok) throw new Error("expected plan amendment");
  expect(amendment.record.record_generation).toBe(staleGeneration + 1);

  cancelPersistedRuntimeTurn({ butlerData, turnId });

  const cancelled = streams.read(stream.id);
  const receipt = cancelled?.active_claim_receipt_id
    ? new WorkStreamClaimStore(butlerData).readReceipt(cancelled.active_claim_receipt_id)
    : null;
  expect(receipt).toMatchObject({
    before_generation: amendment.record.record_generation,
    after_generation: (amendment.record.record_generation ?? 1) + 1,
  });
  expect(cancelled).toMatchObject({
    state: "cancelled",
    active_contract_id: null,
    claim_lease_expires_at: null,
  });
  expect(new TodoListStore(butlerData).read(todo.list.list_id)?.items[0]?.status).toBe("cancelled");
});

test("principal cancellation tombstone aborts active and restarted turn controllers", () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-principal-cancel-"));
  tempDirs.push(butlerData);
  const turnId = "turn-controller-cancel";
  const activeController = new AbortController();
  const unregister = registerPrincipalTurnAbortController({
    butlerData,
    turnId,
    queueId: "queue-controller-cancel",
    dispatchClaimId: "claim-controller-cancel",
    controller: activeController,
  });

  recordPrincipalTurnCancellation({ butlerData, turnId });

  expect(activeController.signal.aborted).toBe(true);
  expect(principalTurnCancellationRecorded({ butlerData, turnId })).toBe(true);
  unregister();

  const restartedController = new AbortController();
  const unregisterRestarted = registerPrincipalTurnAbortController({
    butlerData,
    turnId,
    queueId: "queue-controller-restart",
    dispatchClaimId: "claim-controller-restart",
    controller: restartedController,
  });
  expect(restartedController.signal.aborted).toBe(true);
  unregisterRestarted();
});

test("exact execution identity dispatches cancellation without a watcher", () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-principal-cancel-"));
  tempDirs.push(butlerData);
  const turnId = "turn-external-controller-cancel";
  const controller = new AbortController();
  const unregister = registerPrincipalTurnAbortController({
    butlerData,
    turnId,
    queueId: "queue-exact",
    dispatchClaimId: "claim-exact",
    controller,
  });

  expect(abortPrincipalTurnExecution({
    butlerData,
    turnId,
    queueId: "queue-exact",
    dispatchClaimId: "claim-stale",
  })).toBe("execution_identity_mismatch");
  expect(controller.signal.aborted).toBe(false);
  expect(abortPrincipalTurnExecution({
    butlerData,
    turnId,
    queueId: "queue-exact",
    dispatchClaimId: "claim-exact",
  })).toBe("signal_dispatched");
  expect(controller.signal.aborted).toBe(true);
  expect(() => throwIfRuntimeTurnAborted(controller.signal)).toThrow("Runtime turn was cancelled");
  unregister();
});

test("local cancel endpoint aborts only a durably cancelled exact claim", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-principal-cancel-"));
  tempDirs.push(butlerData);
  mkdirSync(join(butlerData, "app-server"), { recursive: true });
  const db = new Database(join(butlerData, "app-server", "butler-client.sqlite"), {
    create: true,
  });
  db.exec("CREATE TABLE turns (id TEXT PRIMARY KEY, state TEXT NOT NULL)");
  db.exec(`
    CREATE TABLE app_turn_cancel_outbox (
      turn_id TEXT PRIMARY KEY,
      queue_id TEXT,
      dispatch_claim_id TEXT,
      state TEXT NOT NULL,
      accepted_at TEXT,
      completed_at TEXT
    )
  `);
  db.query("INSERT INTO turns (id, state) VALUES (?, 'thinking')")
    .run("turn-socket-cancel");
  db.query(`
    INSERT INTO app_turn_cancel_outbox (
      turn_id, queue_id, dispatch_claim_id, state
    ) VALUES (?, ?, ?, 'pending')
  `).run(
    "turn-socket-cancel",
    "queue-socket-cancel",
    "claim-socket-cancel",
  );
  db.close();

  const controller = new AbortController();
  const unregister = registerPrincipalTurnAbortController({
    butlerData,
    turnId: "turn-socket-cancel",
    queueId: "queue-socket-cancel",
    dispatchClaimId: "claim-socket-cancel",
    controller,
  });
  const server = await startPrincipalTurnCancellationServer(butlerData);
  try {
    const decisionDb = new Database(
      join(butlerData, "app-server", "butler-client.sqlite"),
    );
    decisionDb.query("UPDATE turns SET state = 'cancelled' WHERE id = ?")
      .run("turn-socket-cancel");
    decisionDb.close();
    const stale = await sendCancelExecutionRequest(butlerData, {
      version: 1,
      action: "cancel_execution",
      turn_id: "turn-socket-cancel",
      queue_id: "queue-socket-cancel",
      dispatch_claim_id: "claim-stale",
    });
    expect(stale?.outcome).toBe("execution_identity_mismatch");
    expect(controller.signal.aborted).toBe(false);

    const exact = await sendCancelExecutionRequest(butlerData, {
      version: 1,
      action: "cancel_execution",
      turn_id: "turn-socket-cancel",
      queue_id: "queue-socket-cancel",
      dispatch_claim_id: "claim-socket-cancel",
    });
    expect(exact?.outcome).toBe("signal_dispatched");
    expect(controller.signal.aborted).toBe(true);
    const acceptedDb = new Database(
      join(butlerData, "app-server", "butler-client.sqlite"),
      { readonly: true },
    );
    expect(
      acceptedDb
        .query<{ state: string; accepted_at: string | null }, []>(`
          SELECT state, accepted_at FROM app_turn_cancel_outbox
        `)
        .get(),
    ).toMatchObject({ state: "accepted", accepted_at: expect.any(String) });
    acceptedDb.close();
  } finally {
    unregister();
    await server.close();
  }
});

test("principal cancellation registry contains no filesystem watcher", () => {
  const source = readFileSync(
    join(
      process.cwd(),
      "packages/butler-agent/src/agent/turn/principal-turn-cancellation-registry.ts",
    ),
    "utf8",
  );
  expect(source).not.toContain("watchFile");
  expect(source).not.toContain("unwatchFile");
  expect(source).not.toContain("setInterval");
});

test("completed turn registration is removed before a later cancellation record", () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-principal-cancel-"));
  tempDirs.push(butlerData);
  const turnId = "turn-completed-before-cancel";
  const controller = new AbortController();
  const unregister = registerPrincipalTurnAbortController({
    butlerData,
    turnId,
    queueId: "queue-completed",
    dispatchClaimId: "claim-completed",
    controller,
  });

  unregister();
  unregister();
  recordPrincipalTurnCancellation({ butlerData, turnId });

  expect(controller.signal.aborted).toBe(false);
});

async function waitForLockEntry(logPath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (
    (!existsSync(logPath) || !readFileSync(logPath, "utf8").includes('"event":"enter"')) &&
    Date.now() < deadline
  ) {
    await Bun.sleep(10);
  }
  expect(readFileSync(logPath, "utf8")).toContain('"event":"enter"');
}
