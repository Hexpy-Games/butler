import { fileURLToPath } from "node:url";

type ProjectLedgerRecord = {
  filePath: string;
  record: {
    id: string;
    kind: string;
    status?: string;
    parentId?: string;
    spec?: string;
    specExemption?: boolean;
  };
};

export type ProjectLedgerCore = {
  initProject(options: Record<string, unknown>): unknown;
  ledgerRoot(project: string): string;
  migrateDocs(project: string, options: Record<string, unknown>): unknown;
  abortProjectLedgerPublication(publication: unknown): void;
  createRecord(project: string, options: Record<string, unknown>): unknown;
  createAttempt(project: string, options: Record<string, unknown>): unknown;
  createTask(project: string, options: Record<string, unknown>): unknown;
  createWork(project: string, options: Record<string, unknown>): unknown;
  updateRecord(project: string, options: Record<string, unknown>): unknown;
  updateTask(project: string, options: Record<string, unknown>): unknown;
  updateWork(project: string, options: Record<string, unknown>): unknown;
  buildIndex(project: string): {
    records: Array<{
      id: string;
      kind: string;
      title: string;
      status: string;
      path: string;
    }>;
  };
  check(project: string): { ok: boolean; issues?: unknown[] };
  render(project: string, view: string, options: Record<string, unknown>): unknown;
  projectPath(project: string, path: string): string;
  readRecordBody(filePath: string): string | null;
  readRecordData(filePath: string): Record<string, unknown> | null;
  resolveRecord(
    project: string,
    options: { id: string; kind?: string },
  ): ProjectLedgerRecord;
  planTransitionPath(kind: string, from: string | undefined, to: string): string[];
  observeProjectLedgerPromotion(publication: unknown): unknown;
  observeProjectLedgerSourceHead(project: string): {
    projectRoot: string;
    sourceSha256: string;
    sourceFileCount: number;
    storageSha256: string;
    storageEntryCount: number;
  };
  prepareProjectLedgerPublication(input: Record<string, unknown>): unknown;
  loadPreparedProjectLedgerPublication(input: Record<string, unknown>): unknown;
  promoteProjectLedgerPublication(
    publication: unknown,
    exchangeRoots: (left: string, right: string) => void,
  ): unknown;
  reconcilePublicationClaim(path: string, transaction: unknown, referenced: boolean): void;
};

let corePromise: Promise<ProjectLedgerCore> | null = null;

export function loadProjectLedgerCore(): Promise<ProjectLedgerCore> {
  corePromise ??= loadCore();
  return corePromise;
}

async function loadCore(): Promise<ProjectLedgerCore> {
  const [commands, docs, filesystem, lifecycle, records, recordCommands, stateMachine,
    transactions, indexer, renderer] =
    await Promise.all([
      import(corePath("commands.js")),
      import(corePath("docs-migration.js")),
      import(corePath("fs.js")),
      import(corePath("lifecycle-commands.js")),
      import(corePath("records.js")),
      import(corePath("record-commands.js")),
      import(corePath("state-machine.js")),
      import(corePath("transactions/index.js")),
      import(corePath("indexer.js")),
      import(corePath("renderer.js")),
    ]);
  return {
    initProject: commands.initProject,
    ledgerRoot: filesystem.ledgerRoot,
    migrateDocs: docs.migrateDocs,
    abortProjectLedgerPublication: transactions.abortProjectLedgerPublication,
    createRecord: recordCommands.createRecord,
    createAttempt: lifecycle.createAttempt,
    createTask: lifecycle.createTask,
    createWork: lifecycle.createWork,
    updateRecord: recordCommands.updateRecord,
    updateTask: lifecycle.updateTask,
    updateWork: lifecycle.updateWork,
    buildIndex: indexer.buildIndex,
    check: indexer.check,
    render: renderer.render,
    projectPath: filesystem.projectPath,
    readRecordBody: records.readRecordBody,
    readRecordData: records.readRecordData,
    resolveRecord: recordCommands.resolveRecord,
    planTransitionPath: stateMachine.planTransitionPath,
    observeProjectLedgerPromotion: transactions.observeProjectLedgerPromotion,
    observeProjectLedgerSourceHead: transactions.observeProjectLedgerSourceHead,
    prepareProjectLedgerPublication: transactions.prepareProjectLedgerPublication,
    loadPreparedProjectLedgerPublication: transactions.loadPreparedProjectLedgerPublication,
    promoteProjectLedgerPublication: transactions.promoteProjectLedgerPublication,
    reconcilePublicationClaim: transactions.reconcilePublicationClaim,
  };
}

function corePath(fileName: string): string {
  return fileURLToPath(new URL(
    `../../../../../../project-ledger/src/${fileName}`,
    import.meta.url,
  ));
}
