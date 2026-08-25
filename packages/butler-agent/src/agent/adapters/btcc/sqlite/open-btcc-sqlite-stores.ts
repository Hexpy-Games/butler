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
import type { Database } from "bun:sqlite";
import {
  createProductionScopeSelectedWorkStore,
  type ProductionWorkSelection,
} from "../scope-selected-work-store.ts";
import { SqliteProjectWorkResultRuntime } from "./project-work-result-runtime.ts";
import { SqliteProjectWorkLegacyRuntime } from "./project-work-legacy-runtime.ts";
import { createSqliteProjectWorkRuntimeProjection } from
  "./project-work-runtime-projection.ts";

export function openBtccSqliteStores(input: {
  dbPath: string;
  ownerId: string;
  legacyProjectWorkSource?: LegacyProjectWorkSource;
  runtimeOwnerIdentity?: RuntimeOwnerIdentity;
  processLiveness?: ProcessLiveness;
  storageProfile?: SqliteStorageProfile;
}) {
  return openStores(input);
}

export function openProductionBtccSqliteStores(input: {
  dbPath: string;
  ownerId: string;
  legacyProjectWorkSource?: LegacyProjectWorkSource;
  runtimeOwnerIdentity?: RuntimeOwnerIdentity;
  processLiveness?: ProcessLiveness;
  storageProfile?: SqliteStorageProfile;
  workSelection: ProductionWorkSelection;
}) {
  if (!input.workSelection?.sessionBindings ||
      !input.workSelection.projectLedgerResolver) {
    throw new Error("production_work_selection_collaborator_missing");
  }
  return openStores(input);
}

function openStores(input: {
  dbPath: string;
  ownerId: string;
  legacyProjectWorkSource?: LegacyProjectWorkSource;
  runtimeOwnerIdentity?: RuntimeOwnerIdentity;
  processLiveness?: ProcessLiveness;
  storageProfile?: SqliteStorageProfile;
  workSelection?: ProductionWorkSelection;
}) {
  mkdirSync(dirname(input.dbPath), { recursive: true });
  const connection = openOwnedSqliteConnection(input.dbPath);
  const db = connection.database;
  coordinateSharedSqliteWriter(db, input.storageProfile);
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  migrateBtccSchema(db);
  const legacyCutover = cutoverLegacyBtccTurns(db);

  const processLiveness = input.processLiveness ?? new LocalProcessLiveness();
  const owner = new SqliteRuntimeOwnerRegistry(
    db,
    input.runtimeOwnerIdentity ?? currentRuntimeOwnerIdentity(input.ownerId),
    processLiveness,
  );
  // The one PrincipalAuthority aggregate/repository instance is constructed
  // before the Turn repository so Turn-stop persistence can reuse its narrow
  // closeSelfSession capability inside the same SQLite stop transaction, and
  // before the Guided Work store so factual Work abandonment can reuse its
  // narrow closeAbandonedWork capability inside the same SQLite Work
  // transaction. Every authority path shares this single instance.
  const authority = createPrincipalAuthority(
    new SqlitePrincipalAuthorityRepository(db),
  );
  const turns = new SqliteGuidedTurnStateRepository(db, owner, authority);
  const sqliteWriteReadiness = createSqliteWriteReadiness(input.dbPath);
  const sessionWorkStore = new SqliteGuidedWorkStore(
    db,
    authority,
    input.legacyProjectWorkSource,
  );
  const durableWorkStore = input.workSelection
    ? productionWorkStore(
        db,
        sessionWorkStore,
        input.legacyProjectWorkSource,
        input.workSelection,
      )
    : sessionWorkStore;
  const durableWork = createDurableWorkService(durableWorkStore);
  const subsessionStore = new SqliteSubsessionDelegationStore(db);
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
    stewardObserver: new SqliteStewardObserverStore(db, processLiveness),
    legacyCutover,
    committedSuccessorReadiness: sqliteWriteReadiness,
    close: () => {
      owner.close();
      if (db.inTransaction) throw new Error("BTCC database transaction remained open at close");
      connection.close();
    },
  };
}

function productionWorkStore(
  db: Database,
  sessionStore: SqliteGuidedWorkStore,
  legacyProjectWorkSource: LegacyProjectWorkSource | undefined,
  selection: ProductionWorkSelection,
) {
  const resultRuntime = new SqliteProjectWorkResultRuntime(db);
  return createProductionScopeSelectedWorkStore({
    db,
    sessionStore,
    selection,
    runtimeProjection: createSqliteProjectWorkRuntimeProjection(
      db,
      resultRuntime,
    ),
    resultRuntime,
    legacyRuntime: new SqliteProjectWorkLegacyRuntime(
      db,
      legacyProjectWorkSource,
    ),
  });
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
