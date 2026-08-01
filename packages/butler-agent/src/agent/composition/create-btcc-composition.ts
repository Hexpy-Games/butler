import {
  createProjectLedgerLegacyWorkSource,
  openBtccSqliteStores,
} from "../adapters/index.ts";
import {
  type BtccRunCommand,
  type BtccStopCommand,
  type BtccTurnOutcome,
  type BtccTurnProgressObserver,
  type BtccTurnRuntime,
} from "../btcc/index.ts";
import { createGuidedTurnRuntime } from "../btcc/guided-turn/index.ts";
import { ActiveProjectLedgerResolver } from
  "../../integrations/project-ledger/active-project-ledger-reference.ts";
import type { FunctionToolPromptOptions } from
  "../../integrations/providers/runtime-contracts.ts";
import {
  BtccTurnProgressHub,
  createProductionGuidedTurnAgent,
} from "./production-btcc/index.ts";

type ClosableBtccTurnRuntime = BtccTurnRuntime & { close(): Promise<void> };
type BtccStores = ReturnType<typeof openBtccSqliteStores>;

export function createProductionBtccComposition(input: {
  butlerHome: string;
  butlerData: string;
  appMessageDbPath: string;
  ownerId: string;
  promptRunner?: (options: FunctionToolPromptOptions) => Promise<string>;
}) {
  const projectLedgerResolver = new ActiveProjectLedgerResolver();
  const legacyProjectWorkSource = createProjectLedgerLegacyWorkSource({
    butlerData: input.butlerData,
    appMessageDbPath: input.appMessageDbPath,
    resolver: projectLedgerResolver,
  });
  const stores = openBtccSqliteStores({
    dbPath: input.appMessageDbPath,
    ownerId: input.ownerId,
    legacyProjectWorkSource,
  });
  const progress = new BtccTurnProgressHub();
  const runtime = createGuidedTurnRuntime({
    admission: stores.admission,
    turns: stores.turns,
    messages: stores.messages,
    committedSuccessorReadiness: stores.committedSuccessorReadiness,
    progress,
    agent: createProductionGuidedTurnAgent({
      butlerHome: input.butlerHome,
      butlerData: input.butlerData,
      appMessageDbPath: input.appMessageDbPath,
      contextDocuments: stores.contextDocuments,
      toolJournal: stores.guidedToolJournal,
      effectJournal: stores.guidedEffectJournal,
      durableWork: stores.durableWork,
      ...(input.promptRunner ? { promptRunner: input.promptRunner } : {}),
    }),
  });
  const owned = ownBtccComposition(runtime, stores);
  return {
    runtime: owned,
    contextDocuments: stores.contextDocuments,
    observeTurn: (turnId: string, observer: BtccTurnProgressObserver) =>
      progress.observe(turnId, observer),
    close: owned.close,
    ready: Promise.resolve(),
  };
}

function ownBtccComposition(
  runtime: BtccTurnRuntime,
  stores: BtccStores,
): ClosableBtccTurnRuntime {
  const active = new Set<Promise<BtccTurnOutcome>>();
  let closePromise: Promise<void> | null = null;
  const track = (start: () => Promise<BtccTurnOutcome>): Promise<BtccTurnOutcome> => {
    if (closePromise) throw new Error("BTCC composition is closing");
    const tracked = start().finally(() => active.delete(tracked));
    active.add(tracked);
    return tracked;
  };
  return {
    runTurn(command: BtccRunCommand) {
      return track(() => runtime.runTurn(command));
    },
    stopTurn(command: BtccStopCommand) {
      return track(() => runtime.stopTurn(command));
    },
    close() {
      closePromise ??= closeOwnedBtccComposition(stores, active);
      return closePromise;
    },
  };
}

async function closeOwnedBtccComposition(
  stores: BtccStores,
  active: Set<Promise<BtccTurnOutcome>>,
): Promise<void> {
  await Promise.allSettled([...active]);
  stores.close();
}
