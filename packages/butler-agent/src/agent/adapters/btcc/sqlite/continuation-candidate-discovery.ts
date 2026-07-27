import type { Database } from "bun:sqlite";
import type {
  BtccPersistenceTypes,
  FreshBtccTurnCommand,
} from "../../../btcc/gateway-api.ts";
import { ledgerManifestContentHash } from "../../../btcc/gateway-api.ts";
import type { ProjectWorkLedgerPublicationAdapter } from "../project-ledger/index.ts";
import { digest, stableJson } from "./identity.ts";
import { SqliteWorkLedgerProgramReader } from "./work-ledger/work-ledger-program-reader.ts";
import {
  loadStoppedFinalizationContext,
  type StoppedFinalizationRow,
} from "./stopped-finalization-authority.ts";

type Candidate = BtccPersistenceTypes["continuationCandidate"];
type CandidateBody = Candidate extends infer Entry
  ? Entry extends Candidate
    ? Omit<Entry, "candidateId" | "context">
    : never
  : never;
type ManagedDeferralProduct = BtccPersistenceTypes["managedDeferralProduct"];
type ProjectRuntime = {
  publications: ProjectWorkLedgerPublicationAdapter;
  resolveProjectRoot(projectRef: string): string;
};

export async function discoverContinuationCandidates(
  db: Database,
  command: FreshBtccTurnCommand,
  project?: ProjectRuntime,
): Promise<Candidate[]> {
  const deferred = command.context.projectRef
    ? await discoverProjectCandidates(db, command.context.projectRef, project)
    : discoverSessionCandidates(db, command.sessionId);
  const stopped = await discoverStoppedCandidates(db, command, project);
  const finalization = await discoverFinalizationCandidates(db, command, project);
  return [...deferred, ...stopped, ...finalization]
    .sort((left, right) => left.candidateId.localeCompare(right.candidateId));
}

async function discoverFinalizationCandidates(
  db: Database,
  command: FreshBtccTurnCommand,
  project?: ProjectRuntime,
): Promise<Candidate[]> {
  const scopeKind = command.context.projectRef ? "project" : "session";
  const scopeId = command.context.projectRef ?? command.sessionId;
  const rows = db.query<StoppedFinalizationRow, [string, string]>(`
    SELECT c.candidate_id, c.anchor_id, c.anchor_sha256, c.blocker_id,
      c.blocker_sha256, c.source_turn_id, c.ledger_id, c.program_id,
      c.expected_manifest_revision, c.base_manifest_hash, c.goal_contract_ref,
      c.resume_at
    FROM btcc_stopped_finalization_continuations c
    JOIN btcc_turns t ON t.turn_id = c.source_turn_id
    WHERE c.scope_kind = ? AND c.scope_id = ? AND c.status = 'eligible'
      AND t.semantic_state = 'cancelled' AND t.final_disposition = 'cancelled'
    ORDER BY c.program_id
  `).all(scopeKind, scopeId);
  const sessionPrograms = new SqliteWorkLedgerProgramReader(db);
  const projectRoot = command.context.projectRef && project
    ? project.resolveProjectRoot(command.context.projectRef)
    : undefined;
  const candidates: Candidate[] = [];
  for (const row of rows) {
    const program = projectRoot && project
      ? await project.publications.loadProgram(projectRoot, row.program_id)
      : sessionPrograms.load(row.program_id);
    if (!program || program.planningState !== "reviewed" ||
      program.manifestRevision !== row.expected_manifest_revision ||
      program.frontier !== "closed") continue;
    const currentHash = ledgerManifestContentHash(program, {
      ledgerId: row.ledger_id,
      programId: row.program_id,
    });
    if (currentHash !== row.base_manifest_hash) continue;
    const context = loadStoppedFinalizationContext(db, row, program);
    candidates.push(candidate({
      continuationKind: "managed_finalization",
      ledgerId: row.ledger_id,
      programId: row.program_id,
      expectedManifestRevision: row.expected_manifest_revision,
      baseManifestHash: row.base_manifest_hash,
      sourceTurnId: row.source_turn_id,
      originalGoalContractRef: program.goalContractRef,
      anchorRef: { id: row.anchor_id, sha256: row.anchor_sha256 },
      blockerRef: { id: row.blocker_id, sha256: row.blocker_sha256 },
    }, context, row.candidate_id));
  }
  return candidates;
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
      continuationKind: "managed_deferral",
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
    candidate_id: string;
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
      continuationKind: "managed_deferral",
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

async function discoverStoppedCandidates(
  db: Database,
  command: FreshBtccTurnCommand,
  project?: ProjectRuntime,
): Promise<Candidate[]> {
  type Row = {
    candidate_id: string;
    anchor_id: string;
    anchor_sha256: string;
    blocker_id: string;
    blocker_sha256: string;
    source_turn_id: string;
    ledger_id: string;
    program_id: string;
    expected_manifest_revision: number;
    base_manifest_hash: string;
    goal_contract_ref: string;
    context_json: string;
  };
  const scopeKind = command.context.projectRef ? "project" : "session";
  const scopeId = command.context.projectRef ?? command.sessionId;
  const rows = db.query<Row, [string, string]>(`
    SELECT c.candidate_id, c.anchor_id, c.anchor_sha256, c.blocker_id, c.blocker_sha256,
      c.source_turn_id, c.ledger_id, c.program_id, c.expected_manifest_revision,
      c.base_manifest_hash, c.goal_contract_ref, c.context_json
    FROM btcc_stopped_program_continuations c
    JOIN btcc_turns t ON t.turn_id = c.source_turn_id
    WHERE c.scope_kind = ? AND c.scope_id = ? AND c.status = 'eligible'
      AND t.semantic_state = 'cancelled' AND t.final_disposition = 'cancelled'
    ORDER BY c.program_id
  `).all(scopeKind, scopeId);
  const sessionPrograms = new SqliteWorkLedgerProgramReader(db);
  const projectRoot = command.context.projectRef && project
    ? project.resolveProjectRoot(command.context.projectRef)
    : undefined;
  const candidates: Candidate[] = [];
  for (const row of rows) {
    const program = projectRoot && project
      ? await project.publications.loadProgram(projectRoot, row.program_id)
      : sessionPrograms.load(row.program_id);
    if (!program || program.manifestRevision !== row.expected_manifest_revision) continue;
    const currentHash = ledgerManifestContentHash(program, {
      ledgerId: row.ledger_id,
      programId: row.program_id,
    });
    if (currentHash !== row.base_manifest_hash) continue;
    const storedContext = JSON.parse(row.context_json) as NonNullable<Candidate["context"]>;
    candidates.push(candidate({
      continuationKind: "user_stopped",
      ledgerId: row.ledger_id,
      programId: row.program_id,
      expectedManifestRevision: row.expected_manifest_revision,
      baseManifestHash: row.base_manifest_hash,
      sourceTurnId: row.source_turn_id,
      originalGoalContractRef: loadRef(db, row.goal_contract_ref),
      anchorRef: { id: row.anchor_id, sha256: row.anchor_sha256 },
      blockerRef: { id: row.blocker_id, sha256: row.blocker_sha256 },
    }, {
      ...storedContext,
      ...(program.planningState === "reviewed" ? { acceptedPlan: program.acceptedPlan } : {}),
    }, row.candidate_id));
  }
  return candidates;
}

function candidate(
  body: CandidateBody,
  context: NonNullable<Candidate["context"]>,
  expectedCandidateId?: string,
): Candidate {
  const candidateId = digest(`btcc-continuation-candidate.v1\0${stableJson(body)}`);
  if (expectedCandidateId && candidateId !== expectedCandidateId) {
    throw new Error("Stopped continuation candidate identity changed");
  }
  if (body.continuationKind === "managed_finalization") {
    if (!context.finalization) {
      throw new Error("Finalization continuation context is missing");
    }
    return {
      candidateId,
      ...body,
      context: { ...context, finalization: context.finalization },
    };
  }
  return { candidateId, ...body, context };
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
