import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  coordinateSharedSqliteWriter,
  type SqliteStorageProfile,
} from "../../../../foundation/sqlite-writer-coordination.ts";
import { SqliteCanonicalMessageStore } from "./canonical-message-store.ts";
import { BTCC_SUCCESSOR_SCHEMA } from "./schema.ts";
import { migrateBtccSchema } from "./schema/migrate-schema.ts";
import { SqliteTurnAdmissionRepository } from "./turn-admission-repository.ts";
import { SqliteGuidedTurnStateRepository } from
  "./sqlite-guided-turn-state-repository.ts";
import { SqliteContextDocumentStore } from "./context/index.ts";
import { createSqliteWriteReadiness } from "./sqlite-write-readiness.ts";
import {
  currentRuntimeOwnerIdentity,
  LocalProcessLiveness,
  SqliteRuntimeOwnerRegistry,
  type ProcessLiveness,
  type RuntimeOwnerIdentity,
} from "./runtime-owner/index.ts";
import { openOwnedSqliteConnection } from
  "../../../../foundation/sqlite/owned-sqlite-connection.ts";
import { SqliteGuidedToolJournal } from "./guided-tool-journal.ts";
import { SqliteGuidedOperationResultReader } from "./guided-operation-result-reader.ts";
import { SqliteGuidedEffectJournal } from "./guided-effect-store.ts";
import { SqliteGuidedWorkStore } from "./guided-work-store.ts";
import {
  createDurableWorkService,
  type LegacyProjectWorkSource,
} from "../../../btcc/work/index.ts";
import {
  cutoverLegacyBtccTurns,
} from "./legacy-turn-cutover/index.ts";
import { SqliteBtccProgressEventRepository } from
  "./sqlite-btcc-progress-event-repository.ts";
import { SqliteBtccWakeAuthorizationRepository } from
  "./sqlite-btcc-wake-authorization-repository.ts";

export function openBtccSqliteStores(input: {
  dbPath: string;
  ownerId: string;
  legacyProjectWorkSource?: LegacyProjectWorkSource;
  runtimeOwnerIdentity?: RuntimeOwnerIdentity;
  processLiveness?: ProcessLiveness;
  storageProfile?: SqliteStorageProfile;
}) {
  mkdirSync(dirname(input.dbPath), { recursive: true });
  const connection = openOwnedSqliteConnection(input.dbPath);
  const db = connection.database;
  coordinateSharedSqliteWriter(db, input.storageProfile);
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  migrateBtccSchema(db);
  const legacyCutover = cutoverLegacyBtccTurns(db);

  const owner = new SqliteRuntimeOwnerRegistry(
    db,
    input.runtimeOwnerIdentity ?? currentRuntimeOwnerIdentity(input.ownerId),
    input.processLiveness ?? new LocalProcessLiveness(),
  );
  const turns = new SqliteGuidedTurnStateRepository(db, owner);
  const sqliteWriteReadiness = createSqliteWriteReadiness(input.dbPath);
  const durableWork = createDurableWorkService(new SqliteGuidedWorkStore(
    db,
    input.legacyProjectWorkSource,
  ));
  return {
    admission: new SqliteTurnAdmissionRepository(
      db,
      turns,
      owner,
    ),
    turns,
    progressEvents: new SqliteBtccProgressEventRepository(db),
    wakeAuthorizations: new SqliteBtccWakeAuthorizationRepository(db),
    messages: new SqliteCanonicalMessageStore(db),
    contextDocuments: new SqliteContextDocumentStore(db),
    guidedToolJournal: new SqliteGuidedToolJournal(db),
    guidedOperationResultReader: new SqliteGuidedOperationResultReader(db),
    guidedEffectJournal: new SqliteGuidedEffectJournal(db),
    durableWork,
    legacyCutover,
    committedSuccessorReadiness: sqliteWriteReadiness,
    close: () => {
      owner.close();
      if (db.inTransaction) throw new Error("BTCC database transaction remained open at close");
      connection.close();
    },
  };
}
