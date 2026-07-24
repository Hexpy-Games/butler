import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { coordinateSharedSqliteWriter } from "../../../../foundation/sqlite-writer-coordination.ts";
import { SqliteCanonicalMessageStore } from "./canonical-message-store.ts";
import { SqlitePhaseConversationStore } from "./phase-conversation-store.ts";
import { BTCC_SUCCESSOR_SCHEMA } from "./schema.ts";
import { migrateBtccSchema } from "./schema/migrate-schema.ts";
import { SqliteTurnAdmissionRepository } from "./turn-admission-repository.ts";
import { SqliteTurnStateRepository } from "./turn-state-repository.ts";
import { SqliteRetrospectiveScheduler } from "./retrospective-scheduler.ts";
import { SqliteContextDocumentStore } from "./context/index.ts";
import { SqlitePhaseGuidanceStore } from "./phase-guidance-store.ts";
import {
  createOperationalRecoveryBoundary,
  createProviderRecoveryReadiness,
} from "../../../btcc/gateway-api.ts";
import { SqliteOperationalRecoveryStore } from "./operational-recovery-store.ts";
import { createSqliteWriteReadiness } from "./sqlite-write-readiness.ts";
import type { ProjectWorkLedgerPublicationAdapter } from "../project-ledger/index.ts";
import {
  currentRuntimeOwnerIdentity,
  LocalProcessLiveness,
  SqliteRuntimeOwnerRegistry,
  type ProcessLiveness,
  type RuntimeOwnerIdentity,
} from "./runtime-owner/index.ts";

export type BtccProjectLedgerRuntime = {
  publications: ProjectWorkLedgerPublicationAdapter;
  resolveProjectRoot(projectRef: string): string;
};

export function openBtccSqliteStores(input: {
  dbPath: string;
  ownerId: string;
  projectLedger?: BtccProjectLedgerRuntime;
  runtimeOwnerIdentity?: RuntimeOwnerIdentity;
  processLiveness?: ProcessLiveness;
}) {
  mkdirSync(dirname(input.dbPath), { recursive: true });
  const db = new Database(input.dbPath);
  coordinateSharedSqliteWriter(db);
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  migrateBtccSchema(db);

  const owner = new SqliteRuntimeOwnerRegistry(
    db,
    input.runtimeOwnerIdentity ?? currentRuntimeOwnerIdentity(input.ownerId),
    input.processLiveness ?? new LocalProcessLiveness(),
  );
  const turns = new SqliteTurnStateRepository(db, owner, input.projectLedger);
  const operationalRecovery = createOperationalRecoveryBoundary(
    new SqliteOperationalRecoveryStore(db),
    createSqliteWriteReadiness(input.dbPath, createProviderRecoveryReadiness()),
  );
  return {
    admission: new SqliteTurnAdmissionRepository(
      db,
      turns,
      owner,
      input.projectLedger,
    ),
    turns,
    phaseConversations: new SqlitePhaseConversationStore(db),
    messages: new SqliteCanonicalMessageStore(db),
    retrospective: new SqliteRetrospectiveScheduler(db),
    phaseGuidance: new SqlitePhaseGuidanceStore(db),
    contextDocuments: new SqliteContextDocumentStore(db),
    operationalRecovery,
    close: () => {
      owner.close();
      db.close();
    },
  };
}
