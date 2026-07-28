import {
  createBtccTurnRuntime,
  type BtccRuntimeDependencies,
  type BtccRunCommand,
  type BtccStopCommand,
  type BtccTurnProgressObserver,
  type BtccTurnOutcome,
  type BtccTurnRuntime,
} from "../btcc/index.ts";
import { createProductionSelectedModel } from
  "../btcc/infrastructure/model/index.ts";
import { createProductionOperationRuntime } from
  "../btcc/infrastructure/operations/index.ts";
import {
  createProjectWorkLedgerPublicationAdapter,
  decodeProjectLedgerBinding,
  openBtccSqliteStores,
  type BtccProjectLedgerRuntime,
} from "../adapters/index.ts";
import {
  createProductionCapabilityCatalog,
  createProductionToolRuntime,
  BtccTurnProgressHub,
} from "./production-btcc/index.ts";
import { isAbsolute, join } from "node:path";
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
  const operationRuntime = createProductionOperationRuntime({
    butlerData: input.butlerData,
    resolveTargetScope: async (targetScopeRef) => ({
      targetPath: resolveWorkspaceTargetScope(targetScopeRef),
    }),
    ...createProductionToolRuntime({ ...input, resolveProjectLedgerRoot: resolveProjectRoot }),
  });
  const progress = new BtccTurnProgressHub();
  const governingSpecs = createProjectGoverningSpecAuthority({
    publications,
    resolveProjectRoot,
  });
  if (!governingSpecs) {
    throw new Error("Production Project Ledger has no governing Spec authority");
  }
  const runtime = createBtccTurnRuntime({
    admission: stores.admission,
    turns: stores.turns,
    phaseConversations: stores.phaseConversations,
    model: createProductionSelectedModel({
      context: stores.contextDocuments,
      capabilities: createProductionCapabilityCatalog(),
      guidance: stores.phaseGuidance,
    }),
    operations: operationRuntime.operations,
    artifacts: operationRuntime.artifacts,
    messages: stores.messages,
    retrospective: stores.retrospective,
    operationalRecovery: stores.operationalRecovery,
    committedSuccessorReadiness: stores.committedSuccessorReadiness,
    governingSpecs,
    progress,
  });
  const recoveryTasks = recoverOperationalOwnership(runtime, stores, {
    resumePendingTurns: false,
  });
  const owned = ownBtccComposition(runtime, stores, recoveryTasks);
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
      );
      return closePromise;
    },
  };
}

async function closeOwnedBtccComposition(
  stores: ReturnType<typeof openBtccSqliteStores>,
  recoveryTasks: Promise<Array<Promise<BtccTurnOutcome>>>,
  active: Set<Promise<BtccTurnOutcome>>,
): Promise<void> {
  const recovered = await recoveryTasks;
  await Promise.allSettled([...active, ...recovered]);
  await stores.retrospective.flush();
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

function resolveWorkspaceTargetScope(targetScopeRef: string): string {
  const prefix = "workspace:";
  if (!targetScopeRef.startsWith(prefix)) {
    throw new Error(`BTCC artifact target scope is not a workspace: ${targetScopeRef}`);
  }
  const targetPath = targetScopeRef.slice(prefix.length);
  if (!isAbsolute(targetPath)) {
    throw new Error("BTCC workspace target scope must contain an absolute path");
  }
  return targetPath;
}
