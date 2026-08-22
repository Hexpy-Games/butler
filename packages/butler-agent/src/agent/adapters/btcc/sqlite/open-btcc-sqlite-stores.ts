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
import { selectTurnContinuationBudget } from "../../../btcc/turn/index.ts";
import { createPrincipalAuthority } from "../../../btcc/authority/index.ts";
import { SqlitePrincipalAuthorityRepository } from "./authority-repository.ts";
import { agentBtccStoragePaths } from "./storage-ownership/index.ts";
import { SqliteSubsessionDelegationStore } from "./subsession-store.ts";
import { SqliteStewardObserverStore } from "./steward-observer-store.ts";

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
  const subsessionStore = new SqliteSubsessionDelegationStore(db);
  const authority = createPrincipalAuthority(
    new SqlitePrincipalAuthorityRepository(db),
  );
  return {
    admission: new SqliteTurnAdmissionRepository(
      db,
      turns,
      owner,
      selectTurnContinuationBudget(),
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
    subsessionStore,
    authority,
    legacyCutover,
    committedSuccessorReadiness: sqliteWriteReadiness,
    close: () => {
      owner.close();
      if (db.inTransaction) throw new Error("BTCC database transaction remained open at close");
      connection.close();
    },
  };
}

export function openBtccAuthorityStore(input: { butlerData: string }) {
  const dbPath = agentBtccStoragePaths(input.butlerData).agentBtccDbPath;
  mkdirSync(dirname(dbPath), { recursive: true });
  const connection = openOwnedSqliteConnection(dbPath);
  const db = connection.database;
  coordinateSharedSqliteWriter(db);
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  migrateBtccSchema(db);
  const authority = createPrincipalAuthority(
    new SqlitePrincipalAuthorityRepository(db),
  );
  const observer = new SqliteStewardObserverStore(db);
  let closed = false;
  return {
    authority,
    observer,
    close() {
      if (closed) return;
      closed = true;
      if (db.inTransaction) throw new Error("BTCC database transaction remained open at close");
      connection.close();
    },
  };
}
