import {
  createBtccTurnRuntime,
  createProductionOperationRuntime,
  createProductionSelectedModel,
  type BtccRuntimeDependencies,
  type BtccTurnProgressObserver,
  type BtccTurnRuntime,
} from "../btcc/index.ts";
import { openBtccSqliteStores } from "../adapters/index.ts";
import {
  createProductionCapabilityCatalog,
  createProductionToolRuntime,
  BtccTurnProgressHub,
} from "./production-btcc/index.ts";

export function createBtccComposition(input: {
  dbPath: string;
  ownerId: string;
  model: BtccRuntimeDependencies["model"];
  operations: BtccRuntimeDependencies["operations"];
  artifacts: BtccRuntimeDependencies["artifacts"];
}): BtccTurnRuntime {
  const stores = openBtccSqliteStores({ dbPath: input.dbPath, ownerId: input.ownerId });
  return createBtccTurnRuntime({
    admission: stores.admission,
    turns: stores.turns,
    phaseConversations: stores.phaseConversations,
    model: input.model,
    operations: input.operations,
    artifacts: input.artifacts,
    messages: stores.messages,
    retrospective: stores.retrospective,
  });
}

export function createProductionBtccComposition(input: {
  butlerHome: string;
  butlerData: string;
  appMessageDbPath: string;
  ownerId: string;
}) {
  const stores = openBtccSqliteStores({
    dbPath: input.appMessageDbPath,
    ownerId: input.ownerId,
  });
  const operationRuntime = createProductionOperationRuntime({
    butlerData: input.butlerData,
    resolveTargetScope: async (targetScopeRef) => ({
      targetPath: resolveWorkspaceTargetScope(targetScopeRef),
    }),
    ...createProductionToolRuntime(input),
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
    progress,
  });
  return {
    runtime,
    contextDocuments: stores.contextDocuments,
    observeTurn: (turnId: string, observer: BtccTurnProgressObserver) =>
      progress.observe(turnId, observer),
    close: stores.close,
  };
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
