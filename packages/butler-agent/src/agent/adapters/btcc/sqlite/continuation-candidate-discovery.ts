import type { Database } from "bun:sqlite";
import type {
  BtccPersistenceTypes,
  FreshBtccTurnCommand,
} from "../../../btcc/gateway-api.ts";
import { ledgerManifestContentHash } from "../../../btcc/gateway-api.ts";
import type { ManagedDeferralProduct } from "../../../btcc/deferral/index.ts";
import type { ProjectWorkLedgerPublicationAdapter } from "../project-ledger/index.ts";
import { digest, stableJson } from "./identity.ts";
import { SqliteWorkLedgerProgramReader } from "./work-ledger/work-ledger-program-reader.ts";

type Candidate = BtccPersistenceTypes["deferredContinuationCandidate"];
type ProjectRuntime = {
  publications: ProjectWorkLedgerPublicationAdapter;
  resolveProjectRoot(projectRef: string): string;
};

export async function discoverDeferredContinuationCandidates(
  db: Database,
  command: FreshBtccTurnCommand,
  project?: ProjectRuntime,
): Promise<Candidate[]> {
  return command.context.projectRef
    ? discoverProjectCandidates(db, command.context.projectRef, project)
    : discoverSessionCandidates(db, command.sessionId);
}

async function discoverProjectCandidates(
  db: Database,
  projectRef: string,
  runtime?: ProjectRuntime,
): Promise<Candidate[]> {
  if (!runtime) throw new Error("Project continuation requires Project Ledger authority");
  const root = runtime.resolveProjectRoot(projectRef);
  const candidates: Candidate[] = [];
  for (const program of await runtime.publications.listDeferredPrograms(root)) {
    const deferral = program?.activeDeferral;
    if (!program || !deferral || !isDeferredTurn(db, deferral.anchor.sourceTurnId)) continue;
    candidates.push(candidate({
      ledgerId: program.ledgerId,
      programId: program.programId,
      expectedManifestRevision: program.manifestRevision,
      baseManifestHash: ledgerManifestContentHash(program, {
        ledgerId: program.ledgerId,
        programId: program.programId,
      }),
      sourceTurnId: deferral.anchor.sourceTurnId,
      originalGoalContractRef: program.goalContractRef,
      anchorRef: deferral.anchor.ref,
      blockerRef: deferral.blocker.ref,
    }, continuationContext(
      tryLoadRecordByRef(db, program.goalContractRef),
      deferral,
    )));
  }
  return candidates;
}

function discoverSessionCandidates(db: Database, sessionId: string): Candidate[] {
  type Row = {
    ledger_id: string;
    program_id: string;
    manifest_revision: number;
    goal_contract_ref: string;
    active_deferral_ref: string;
    active_deferral_turn_id: string;
  };
  const rows = db.query<Row, [string]>(`
    SELECT p.ledger_id, p.program_id, p.manifest_revision,
      p.goal_contract_ref, p.active_deferral_ref, p.active_deferral_turn_id
    FROM btcc_programs p
    JOIN btcc_turns t ON t.turn_id = p.active_deferral_turn_id
    WHERE p.scope_kind = 'session' AND p.scope_id = ?
      AND p.active_deferral_ref IS NOT NULL
      AND t.semantic_state = 'delivered' AND t.final_disposition = 'deferred'
    ORDER BY p.program_id
  `).all(sessionId);
  const programs = new SqliteWorkLedgerProgramReader(db);
  return rows.map((row) => {
    const program = programs.load(row.program_id);
    if (!program) throw new Error(`BTCC continuation Program is missing: ${row.program_id}`);
    const anchorRef = loadRef(db, row.active_deferral_ref);
    const anchor = loadRecord<ManagedDeferralProduct["anchor"]>(
      db,
      row.active_deferral_ref,
    );
    const blocker = loadRecord<ManagedDeferralProduct["blocker"]>(
      db,
      anchor.blockerRef.id,
    );
    return candidate({
      ledgerId: row.ledger_id,
      programId: row.program_id,
      expectedManifestRevision: row.manifest_revision,
      baseManifestHash: ledgerManifestContentHash(program, {
        ledgerId: row.ledger_id,
        programId: row.program_id,
      }),
      sourceTurnId: row.active_deferral_turn_id,
      originalGoalContractRef: loadRef(db, row.goal_contract_ref),
      anchorRef,
      blockerRef: anchor.blockerRef,
    }, continuationContext(
      tryLoadRecordByRef(db, loadRef(db, row.goal_contract_ref)),
      { blocker, anchor },
    ));
  });
}

function candidate(
  body: Omit<Candidate, "candidateId" | "context">,
  context: NonNullable<Candidate["context"]>,
): Candidate {
  return {
    candidateId: digest(`btcc-continuation-candidate.v1\0${stableJson(body)}`),
    ...body,
    context,
  };
}

function continuationContext(
  originalGoalContract: Record<string, unknown> | null,
  deferral: Pick<ManagedDeferralProduct, "blocker" | "anchor">,
): NonNullable<Candidate["context"]> {
  return {
    originalGoalContract,
    blocker: {
      sourceState: deferral.blocker.sourceState,
      reason: deferral.blocker.reason,
      readiness: deferral.blocker.readiness,
    },
    frontier: {
      ...(deferral.anchor.currentWorkRef
        ? { currentWorkRef: deferral.anchor.currentWorkRef }
        : {}),
      ...(deferral.anchor.currentTaskRef
        ? { currentTaskRef: deferral.anchor.currentTaskRef }
        : {}),
      openWorkRefs: deferral.anchor.openWorkRefs,
      openTaskRefs: deferral.anchor.openTaskRefs,
    },
  };
}

function isDeferredTurn(db: Database, turnId: string): boolean {
  return Boolean(db.query<{ turn_id: string }, [string]>(`
    SELECT turn_id FROM btcc_turns
    WHERE turn_id = ? AND semantic_state = 'delivered' AND final_disposition = 'deferred'
  `).get(turnId));
}

function loadRef(db: Database, id: string): { id: string; sha256: string } {
  const row = db.query<{ sha256: string }, [string]>(
    "SELECT sha256 FROM btcc_records WHERE record_id = ?",
  ).get(id);
  if (!row) throw new Error(`BTCC continuation record is missing: ${id}`);
  return { id, sha256: row.sha256 };
}

function loadRecord<T>(db: Database, id: string): T {
  const row = db.query<{ content_json: string }, [string]>(
    "SELECT content_json FROM btcc_records WHERE record_id = ?",
  ).get(id);
  if (!row) throw new Error(`BTCC continuation record is missing: ${id}`);
  return JSON.parse(row.content_json) as T;
}

function tryLoadRecordByRef(
  db: Database,
  ref: { id: string; sha256: string },
): Record<string, unknown> | null {
  const row = db.query<{ sha256: string; content_json: string }, [string]>(
    "SELECT sha256, content_json FROM btcc_records WHERE record_id = ?",
  ).get(ref.id);
  if (!row || row.sha256 !== ref.sha256) return null;
  const value = JSON.parse(row.content_json) as unknown;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
