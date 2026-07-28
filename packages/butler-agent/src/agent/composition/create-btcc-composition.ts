import {
  createBtccTurnRuntime,
  type BtccRuntimeDependencies,
  type BtccTurnProgressObserver,
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

export function createBtccComposition(input: {
  dbPath: string;
  ownerId: string;
  model: BtccRuntimeDependencies["model"];
  operations: BtccRuntimeDependencies["operations"];
  artifacts: BtccRuntimeDependencies["artifacts"];
  projectLedger?: BtccProjectLedgerRuntime;
}): BtccTurnRuntime {
  const stores = openBtccSqliteStores({
    dbPath: input.dbPath,
    ownerId: input.ownerId,
    ...(input.projectLedger ? { projectLedger: input.projectLedger } : {}),
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
  const ready = recoverOperationalOwnership(runtime, stores, {
    resumePendingTurns: true,
  });
  return {
    async runTurn(command) {
      await ready;
      return runtime.runTurn(command);
    },
    async stopTurn(command) {
      await ready;
      return runtime.stopTurn(command);
    },
  };
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
  const ready = recoverOperationalOwnership(runtime, stores, {
    resumePendingTurns: false,
  });
  return {
    runtime,
    contextDocuments: stores.contextDocuments,
    observeTurn: (turnId: string, observer: BtccTurnProgressObserver) =>
      progress.observe(turnId, observer),
    close: stores.close,
    ready,
  };
}

async function recoverOperationalOwnership(
  runtime: BtccTurnRuntime,
  stores: ReturnType<typeof openBtccSqliteStores>,
  options: { resumePendingTurns: boolean },
): Promise<void> {
  await stores.turns.recoverPendingProjectLedgerPromotions();
  await stores.operationalRecoveryStartup.activateInheritedRuntimeRemediations();
  if (!options.resumePendingTurns) return;
  const turnIds = await stores.operationalRecovery.pendingTurnIds();
  for (const turnId of turnIds) {
    void runtime.runTurn({ kind: "resume", turnId }).catch(reportRecoveryFailure);
  }
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
