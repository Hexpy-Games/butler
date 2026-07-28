import type { Database } from "bun:sqlite";
import type { ConversationIdFactory } from "../ids.ts";
import type { ConversationStoreInternals } from "../store-internals.ts";

export interface ConversationStoreDependencies {
  db: Database;
  idFactory: ConversationIdFactory;
  internals: ConversationStoreInternals;
}
