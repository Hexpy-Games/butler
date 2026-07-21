import {
  createBtccTurnRuntime,
  type BtccRuntimeDependencies,
  type BtccTurnRuntime,
} from "../btcc/index.ts";
import { openBtccSqliteStores } from "../adapters/index.ts";

export function createBtccComposition(input: {
  dbPath: string;
  ownerId: string;
  model: BtccRuntimeDependencies["model"];
  operations: BtccRuntimeDependencies["operations"];
}): BtccTurnRuntime {
  const stores = openBtccSqliteStores({ dbPath: input.dbPath, ownerId: input.ownerId });
  return createBtccTurnRuntime({
    admission: stores.admission,
    turns: stores.turns,
    phaseConversations: stores.phaseConversations,
    model: input.model,
    operations: input.operations,
    messages: stores.messages,
  });
}
