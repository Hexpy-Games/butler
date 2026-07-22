import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SqliteCanonicalMessageStore } from "./canonical-message-store.ts";
import { SqlitePhaseConversationStore } from "./phase-conversation-store.ts";
import { BTCC_SUCCESSOR_SCHEMA } from "./schema.ts";
import { SqliteTurnAdmissionRepository } from "./turn-admission-repository.ts";
import { SqliteTurnStateRepository } from "./turn-state-repository.ts";
import { SqliteLearningSourceScheduler } from "./learning-source-scheduler.ts";
import { SqliteContextDocumentStore } from "./context/index.ts";
import { SqlitePhaseGuidanceStore } from "./phase-guidance-store.ts";

export function openBtccSqliteStores(input: { dbPath: string; ownerId: string }) {
  mkdirSync(dirname(input.dbPath), { recursive: true });
  const db = new Database(input.dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(BTCC_SUCCESSOR_SCHEMA);

  const turns = new SqliteTurnStateRepository(db, input.ownerId);
  return {
    admission: new SqliteTurnAdmissionRepository(db, turns, input.ownerId),
    turns,
    phaseConversations: new SqlitePhaseConversationStore(db),
    messages: new SqliteCanonicalMessageStore(db),
    learning: new SqliteLearningSourceScheduler(db),
    phaseGuidance: new SqlitePhaseGuidanceStore(db),
    contextDocuments: new SqliteContextDocumentStore(db),
    close: () => db.close(),
  };
}
