import {
  applyTurnLocalWorkOutcomeForSession,
  WorkStreamStore,
  workStreamTerminal,
} from "../work/work-stream.ts";
import { WorkStreamClaimStore } from "../work/work-stream-claim-store.ts";
import { TodoListStore } from "../work/todo-list.ts";
import { recordPrincipalTurnCancellation } from "./principal-turn-cancellation-registry.ts";
import {
  clearTurnContextAtom,
  turnContextAtomsForTurn,
} from "./turn-continuation-context.ts";
import { TurnContractStore } from "./turn-contract-store.ts";

const CANCELLATION_RECONCILIATION_ATTEMPTS = 4;
const CANCELLATION_LOCK_WAIT_MS = 75;

export function cancelPersistedRuntimeTurn(input: {
  butlerData: string;
  turnId: string;
  contractIds?: readonly string[];
}): void {
  recordPrincipalTurnCancellation({ butlerData: input.butlerData, turnId: input.turnId });
  const contracts = new TurnContractStore(input.butlerData);
  const streams = new WorkStreamStore(input.butlerData, { autoRecover: false });
  const claims = new WorkStreamClaimStore(input.butlerData);
  const todos = new TodoListStore(input.butlerData, { autoRecover: false });
  const contractIds = new Set(input.contractIds ?? []);
  const targetWorkStreamIds = new Set<string>();
  const claimedWorkStreams = new Map<string, string>();
  const sessionIds = new Set<string>();
  let failures: string[] = [];

  for (let attempt = 0; attempt < CANCELLATION_RECONCILIATION_ATTEMPTS; attempt += 1) {
    const atoms = turnContextAtomsForTurn(input);
    for (const atom of atoms) {
      sessionIds.add(atom.sessionId);
      if (atom.contractId) contractIds.add(atom.contractId);
    }

    const currentStreams = streams.recordsForTurn(input.turnId);
    for (const stream of currentStreams) {
      if (stream.owner_session_id) sessionIds.add(stream.owner_session_id);
      const cancellationReceipt = stream.active_claim_receipt_id
        ? claims.readReceipt(stream.active_claim_receipt_id)
        : null;
      const replayedCancellationContractId =
        cancellationReceipt?.operation === "cancel" && cancellationReceipt.turn_id === input.turnId
          ? cancellationReceipt.contract_id
          : null;
      if (!workStreamTerminal(stream.state) || stream.active_contract_id || stream.claim_lease_expires_at) {
        targetWorkStreamIds.add(stream.id);
      }
      if (replayedCancellationContractId) targetWorkStreamIds.add(stream.id);
      const contractId = stream.active_contract_id ?? replayedCancellationContractId;
      if (contractId) {
        contractIds.add(contractId);
        claimedWorkStreams.set(stream.id, contractId);
      }
    }

    for (const contractId of contractIds) {
      const contract = contracts.read(contractId);
      if (!contract?.target_workstream_id) continue;
      const target = streams.read(contract.target_workstream_id);
      if (
        target?.last_user_turn_id === input.turnId ||
        target?.active_contract_id === contractId
      ) {
        targetWorkStreamIds.add(contract.target_workstream_id);
        if (target.owner_session_id) sessionIds.add(target.owner_session_id);
      }
    }

    failures = cancelClaimedWorkStreams({
      claims,
      turnId: input.turnId,
      claimedWorkStreams,
    });
    if (failures.length > 0) continue;

    const activeClaims = streams.recordsForTurn(input.turnId)
      .filter((stream) => !workStreamTerminal(stream.state) && Boolean(stream.active_contract_id));
    if (activeClaims.length > 0) {
      failures = activeClaims.map((stream) => `active_claim:${stream.id}`);
      continue;
    }

    failures = cancelUnclaimedTurnLocalWork({
      butlerData: input.butlerData,
      turnId: input.turnId,
      sessionIds,
      streams,
    });
    if (failures.length > 0) continue;

    failures = cancelContracts({
      contracts,
      contractIds,
      turnId: input.turnId,
    });
    if (failures.length > 0) continue;

    for (const atom of turnContextAtomsForTurn(input)) {
      clearTurnContextAtom({
        butlerData: input.butlerData,
        sessionId: atom.sessionId,
        turnId: input.turnId,
      });
    }

    failures = cancellationConvergenceFailures({
      input,
      contracts,
      streams,
      claims,
      todos,
      contractIds,
      targetWorkStreamIds,
      claimedWorkStreams,
    });
    if (failures.length === 0) return;
  }

  throw new Error(`principal_turn_cancellation_reconciliation_failed:${failures.join(",")}`);
}

function cancelClaimedWorkStreams(input: {
  claims: WorkStreamClaimStore;
  turnId: string;
  claimedWorkStreams: ReadonlyMap<string, string>;
}): string[] {
  const failures: string[] = [];
  for (const [workstreamId, contractId] of input.claimedWorkStreams) {
    try {
      const result = input.claims.cancelByPrincipalTurn({
        workstreamId,
        contractId,
        turnId: input.turnId,
        busyTimeoutMs: CANCELLATION_LOCK_WAIT_MS,
      });
      if (!result.ok) failures.push(`${workstreamId}:${result.code}`);
    } catch (error) {
      failures.push(`${workstreamId}:${errorCode(error)}`);
    }
  }
  return failures;
}

function cancelUnclaimedTurnLocalWork(input: {
  butlerData: string;
  turnId: string;
  sessionIds: ReadonlySet<string>;
  streams: WorkStreamStore;
}): string[] {
  const failures: string[] = [];
  for (const sessionId of input.sessionIds) {
    try {
      applyTurnLocalWorkOutcomeForSession({
        butlerData: input.butlerData,
        sessionId,
        turnId: input.turnId,
        outcome: "cancelled",
        statusNote: "Turn cancelled before final delivery.",
      });
    } catch (error) {
      failures.push(`${sessionId}:${errorCode(error)}`);
    }
  }
  for (const stream of input.streams.recordsForTurn(input.turnId)) {
    if (!workStreamTerminal(stream.state)) failures.push(`${stream.id}:workstream_not_terminal`);
  }
  return failures;
}

function cancelContracts(input: {
  contracts: TurnContractStore;
  contractIds: ReadonlySet<string>;
  turnId: string;
}): string[] {
  const failures: string[] = [];
  for (const contractId of input.contractIds) {
    try {
      const contract = input.contracts.recordPrincipalTurnCancellation({
        contractId,
        turnId: input.turnId,
        busyTimeoutMs: CANCELLATION_LOCK_WAIT_MS,
      });
      if (contract.state !== "cancelled") failures.push(`${contractId}:contract_not_cancelled`);
    } catch (error) {
      failures.push(`${contractId}:${errorCode(error)}`);
    }
  }
  return failures;
}

function cancellationConvergenceFailures(input: {
  input: { butlerData: string; turnId: string };
  contracts: TurnContractStore;
  streams: WorkStreamStore;
  claims: WorkStreamClaimStore;
  todos: TodoListStore;
  contractIds: ReadonlySet<string>;
  targetWorkStreamIds: ReadonlySet<string>;
  claimedWorkStreams: ReadonlyMap<string, string>;
}): string[] {
  const failures: string[] = [];
  for (const contractId of input.contractIds) {
    if (input.contracts.read(contractId)?.state !== "cancelled") {
      failures.push(`${contractId}:contract_not_cancelled`);
    }
  }
  for (const workstreamId of input.targetWorkStreamIds) {
    const stream = input.streams.read(workstreamId);
    if (!stream) {
      failures.push(`${workstreamId}:workstream_missing`);
      continue;
    }
    if (stream.state !== "cancelled") failures.push(`${workstreamId}:workstream_not_cancelled`);
    if (stream.active_contract_id) failures.push(`${workstreamId}:active_contract_not_cleared`);
    if (stream.claim_lease_expires_at) failures.push(`${workstreamId}:claim_lease_not_cleared`);
    const contractId = input.claimedWorkStreams.get(workstreamId);
    if (contractId) {
      const receipt = stream.active_claim_receipt_id
        ? input.claims.readReceipt(stream.active_claim_receipt_id)
        : null;
      if (
        receipt?.operation !== "cancel" ||
        receipt.contract_id !== contractId ||
        receipt.turn_id !== input.input.turnId
      ) {
        failures.push(`${workstreamId}:cancellation_receipt_missing`);
      }
    }
    if (stream.todo_list_id) {
      const todo = input.todos.read(stream.todo_list_id);
      if (!todo) {
        failures.push(`${workstreamId}:todo_missing`);
      } else if (todo.items.some((item) => item.status === "pending" || item.status === "in_progress")) {
        failures.push(`${workstreamId}:todo_not_cancelled`);
      }
    }
  }
  for (const stream of input.streams.recordsForTurn(input.input.turnId)) {
    if (!workStreamTerminal(stream.state) || stream.active_contract_id || stream.claim_lease_expires_at) {
      failures.push(`${stream.id}:turn_workstream_not_reconciled`);
    }
  }
  if (turnContextAtomsForTurn(input.input).length > 0) failures.push("continuation_atom_not_cleared");
  return failures;
}

function errorCode(error: unknown): string {
  if (!(error instanceof Error)) return "unknown_error";
  return error.message.replace(/[^A-Za-z0-9._:-]+/g, "_").slice(0, 160);
}
