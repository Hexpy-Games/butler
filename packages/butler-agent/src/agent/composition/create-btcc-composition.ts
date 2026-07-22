import {
  createBtccTurnRuntime,
  createProductionOperationRuntime,
  createProductionSelectedModel,
  type BtccRuntimeDependencies,
  type BtccTurnProgressObserver,
  type BtccTurnRuntime,
} from "../btcc/index.ts";
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
import { join } from "node:path";
import { ActiveProjectLedgerResolver } from
  "../../integrations/project-ledger/active-project-ledger-reference.ts";

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
  return createBtccTurnRuntime({
    admission: stores.admission,
    turns: stores.turns,
    phaseConversations: stores.phaseConversations,
    model: input.model,
    operations: input.operations,
    artifacts: input.artifacts,
    messages: stores.messages,
    retrospective: stores.retrospective,
    operationalRecovery: stores.operationalRecovery,
  });
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
    const reference = binding.kind === "canonical_ledger_id"
      ? projectLedgerResolver.resolve({
          butlerData: input.butlerData,
          explicitRef: binding.ledgerProjectId,
        })
      : projectLedgerResolver.resolve({
          butlerData: input.butlerData,
          appMessageDbPath: input.appMessageDbPath,
          appProjectId: binding.appProjectId,
        });
    if (!reference.initialized) {
      throw new Error("Project-bound BTCC work requires an initialized Project Ledger");
    }
    return reference.ledger_root;
  };
  const stores = openBtccSqliteStores({
    dbPath: input.appMessageDbPath,
    ownerId: input.ownerId,
    projectLedger: {
      publications: createProjectWorkLedgerPublicationAdapter({
        stagingRoot: join(input.butlerData, "runtime", "btcc-project-ledger-publications"),
      }),
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
    progress,
  });
  const ready = recoverOperationalOwnership(runtime, stores);
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
): Promise<void> {
  await stores.turns.recoverPendingProjectLedgerPromotions();
  const turnIds = await stores.operationalRecovery.pendingTurnIds();
  for (const turnId of turnIds) {
    void runtime.handle({ kind: "resume", turnId }).catch(reportRecoveryFailure);
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
  if (!targetPath.startsWith("/")) {
    throw new Error("BTCC workspace target scope must contain an absolute path");
  }
  return targetPath;
}
