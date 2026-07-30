import {
  createGuidedTurnRuntime,
  createBtccTurnRuntime,
  type BtccRuntimeDependencies,
  type BtccRunCommand,
  type BtccStopCommand,
  type BtccTurnProgressObserver,
  type BtccTurnOutcome,
  type BtccTurnRuntime,
} from "../btcc/index.ts";
import {
  createProjectWorkLedgerPublicationAdapter,
  decodeProjectLedgerBinding,
  openBtccSqliteStores,
  type BtccProjectLedgerRuntime,
} from "../adapters/index.ts";
import {
  BtccTurnProgressHub,
  createProductionGuidedTurnAgent,
} from "./production-btcc/index.ts";
import { join } from "node:path";
import { ActiveProjectLedgerResolver } from
  "../../integrations/project-ledger/active-project-ledger-reference.ts";
import { ensureActiveProjectLedger } from
  "../../integrations/project-ledger/ensure-active-project-ledger.ts";
import { createProjectGoverningSpecAuthority } from
  "./project-governing-spec-authority.ts";
import type { SqliteStorageProfile } from
  "../../foundation/sqlite-writer-coordination.ts";

type ClosableBtccTurnRuntime = BtccTurnRuntime & { close(): Promise<void> };

export function createBtccComposition(input: {
  dbPath: string;
  ownerId: string;
  model: BtccRuntimeDependencies["model"];
  operations: BtccRuntimeDependencies["operations"];
  artifacts: BtccRuntimeDependencies["artifacts"];
  projectLedger?: BtccProjectLedgerRuntime;
  storageProfile?: SqliteStorageProfile;
}): ClosableBtccTurnRuntime {
  const stores = openBtccSqliteStores({
    dbPath: input.dbPath,
    ownerId: input.ownerId,
    ...(input.projectLedger ? { projectLedger: input.projectLedger } : {}),
    ...(input.storageProfile ? { storageProfile: input.storageProfile } : {}),
  });
  const governingSpecs = input.projectLedger
    ? createProjectGoverningSpecAuthority(input.projectLedger)
    : undefined;
  const runtime = createBtccTurnRuntime({
    admission: stores.admission,
    turns: stores.turns,
    phaseConversations: stores.phaseConversations,
    model: input.model,
    operations: input.operations,
    artifacts: input.artifacts,
    messages: stores.messages,
    retrospective: stores.retrospective,
    operationalRecovery: stores.operationalRecovery,
    committedSuccessorReadiness: stores.committedSuccessorReadiness,
    ...(governingSpecs
      ? { governingSpecs }
      : {}),
  });
  const recoveryTasks = recoverOperationalOwnership(runtime, stores, {
    resumePendingTurns: true,
  });
  return ownBtccComposition(runtime, stores, recoveryTasks);
}

export function createProductionBtccComposition(input: {
  butlerHome: string;
  butlerData: string;
  appMessageDbPath: string;
  ownerId: string;
}) {
  const projectLedgerResolver = new ActiveProjectLedgerResolver();
  const resolveProjectRoot = (projectRef: string): string => {
    const binding = decodeProjectLedgerBinding(projectRef);
    return ensureActiveProjectLedger({
      resolver: projectLedgerResolver,
      butlerHome: input.butlerHome,
      butlerData: input.butlerData,
      lookup: binding.kind === "canonical_ledger_id"
        ? { explicitRef: binding.ledgerProjectId }
        : {
            appMessageDbPath: input.appMessageDbPath,
            appProjectId: binding.appProjectId,
          },
    }).ledger_root;
  };
  const publications = createProjectWorkLedgerPublicationAdapter({
    stagingRoot: join(input.butlerData, "runtime", "btcc-project-ledger-publications"),
  });
  const stores = openBtccSqliteStores({
    dbPath: input.appMessageDbPath,
    ownerId: input.ownerId,
    projectLedger: {
      publications,
      resolveProjectRoot,
    },
  });
  const progress = new BtccTurnProgressHub();
  const runtime = createGuidedTurnRuntime({
    admission: stores.admission,
    turns: stores.turns,
    messages: stores.messages,
    retrospective: stores.retrospective,
    committedSuccessorReadiness: stores.committedSuccessorReadiness,
    progress,
    agent: createProductionGuidedTurnAgent({
      butlerHome: input.butlerHome,
      butlerData: input.butlerData,
      appMessageDbPath: input.appMessageDbPath,
      contextDocuments: stores.contextDocuments,
      toolJournal: stores.guidedToolJournal,
    }),
  });
  const recoveryTasks = recoverOperationalOwnership(runtime, stores, {
    resumePendingTurns: false,
  });
  const owned = ownBtccComposition(
    runtime,
    stores,
    recoveryTasks,
  );
  return {
    runtime: owned,
    contextDocuments: stores.contextDocuments,
    observeTurn: (turnId: string, observer: BtccTurnProgressObserver) =>
      progress.observe(turnId, observer),
    close: owned.close,
    ready: recoveryTasks.then(() => undefined),
  };
}

function ownBtccComposition(
  runtime: BtccTurnRuntime,
  stores: ReturnType<typeof openBtccSqliteStores>,
  recoveryTasks: Promise<Array<Promise<BtccTurnOutcome>>>,
  closeOperations?: () => void,
): ClosableBtccTurnRuntime {
  const active = new Set<Promise<BtccTurnOutcome>>();
  let closePromise: Promise<void> | null = null;

  const track = (
    start: () => Promise<BtccTurnOutcome>,
  ): Promise<BtccTurnOutcome> => {
    if (closePromise) throw new Error("BTCC composition is closing");
    const tracked = start().finally(() => active.delete(tracked));
    active.add(tracked);
    return tracked;
  };

  return {
    runTurn(command: BtccRunCommand) {
      return track(() => recoveryTasks.then(() => runtime.runTurn(command)));
    },
    stopTurn(command: BtccStopCommand) {
      return track(() => recoveryTasks.then(() => runtime.stopTurn(command)));
    },
    close() {
      closePromise ??= closeOwnedBtccComposition(
        stores,
        recoveryTasks,
        active,
        closeOperations,
      );
      return closePromise;
    },
  };
}

async function closeOwnedBtccComposition(
  stores: ReturnType<typeof openBtccSqliteStores>,
  recoveryTasks: Promise<Array<Promise<BtccTurnOutcome>>>,
  active: Set<Promise<BtccTurnOutcome>>,
  closeOperations?: () => void,
): Promise<void> {
  const recovered = await recoveryTasks;
  await Promise.allSettled([...active, ...recovered]);
  await stores.retrospective.flush();
  closeOperations?.();
  stores.close();
}

async function recoverOperationalOwnership(
  runtime: BtccTurnRuntime,
  stores: ReturnType<typeof openBtccSqliteStores>,
  options: { resumePendingTurns: boolean },
): Promise<Array<Promise<BtccTurnOutcome>>> {
  await stores.turns.recoverPendingProjectLedgerPromotions();
  await stores.operationalRecoveryStartup.activateInheritedRuntimeRemediations();
  if (!options.resumePendingTurns) return [];
  const recoveryTasks: Array<Promise<BtccTurnOutcome>> = [];
  const turnIds = await stores.operationalRecovery.pendingTurnIds();
  for (const turnId of turnIds) {
    const recovery = runtime.runTurn({ kind: "resume", turnId });
    recoveryTasks.push(recovery);
    void recovery.catch(reportRecoveryFailure);
  }
  return recoveryTasks;
}

function reportRecoveryFailure(error: unknown): void {
  if (process.env.BUTLER_OPERATIONAL_DIAGNOSTICS !== "1") return;
  console.error(JSON.stringify({
    event: "btcc_operational_recovery_activation_failed",
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  }));
}
