import type { Database } from "bun:sqlite";
import type {
  BtccPersistenceTypes,
  WorkLedgerCommit,
  WorkLedgerStorage,
} from "../../../../btcc/index.ts";
import { SqliteWorkLedgerMutationWriter } from "./work-ledger-mutation-writer.ts";
import { SqliteWorkLedgerProgramReader } from "./work-ledger-program-reader.ts";

type ManagedProgramState = BtccPersistenceTypes["managedProgramState"];

export class SqliteWorkLedgerStorage implements WorkLedgerStorage {
  private readonly mutations: SqliteWorkLedgerMutationWriter;
  private readonly programs: SqliteWorkLedgerProgramReader;

  constructor(db: Database) {
    this.mutations = new SqliteWorkLedgerMutationWriter(db);
    this.programs = new SqliteWorkLedgerProgramReader(db);
  }

  commit(input: WorkLedgerCommit): void {
    this.mutations.commitAtomically(input);
  }

  loadProgram(programId: string): ManagedProgramState | null {
    return this.programs.load(programId);
  }
}
