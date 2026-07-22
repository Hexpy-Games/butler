import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ModelPhaseState } from "../../btcc/core/index.ts";
import type { AcceptedPhaseGuidance } from "../../btcc/guidance/index.ts";
import { SqlitePhaseGuidanceStore } from "../../adapters/btcc/sqlite/index.ts";
import { BTCC_SUCCESSOR_SCHEMA } from "../../adapters/btcc/sqlite/schema.ts";
import { digest, stableJson } from "../../adapters/btcc/sqlite/identity.ts";
import type {
  BtccRetrospective,
  BtccRetrospectiveStore,
  BtccTrajectory,
  RetrospectiveDecisionSet,
} from "./contracts.ts";

type PendingRow = {
  outbox_id: string;
  source_id: string;
  source_json: string;
  original_message: string;
  context_json: string;
  final_payload_json: string;
};

type CheckpointRow = {
  semantic_state: string;
  turn_revision: number;
  accepted_product_json: string;
};

type JsonRow = { value: string };
type MissingSourceRow = {
  turn_id: string;
  final_payload_json: string;
  managed_state_json: string | null;
  opening_answer_json: string | null;
  context_json: string;
};

export class SqliteBtccRetrospectiveStore implements BtccRetrospectiveStore {
  private readonly db: Database;
  private readonly guidance: SqlitePhaseGuidanceStore;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=NORMAL");
    this.db.exec(BTCC_SUCCESSOR_SCHEMA);
    this.guidance = new SqlitePhaseGuidanceStore(this.db);
  }

  loadPendingTrajectories(limit = 20): BtccTrajectory[] {
    this.reconcileMissingSources();
    const rows = this.db.query<PendingRow, [number]>(`
      SELECT o.outbox_id, s.source_id, s.source_json,
             t.original_message, t.context_json, t.final_payload_json
      FROM btcc_learning_candidate_outbox o
      JOIN btcc_learning_sources s ON s.source_id = o.source_id
      JOIN btcc_turns t ON t.turn_id = s.turn_id
      WHERE o.status = 'pending' AND t.semantic_state = 'delivered'
      ORDER BY o.rowid ASC
      LIMIT ?
    `).all(limit);
    return rows.map((row) => this.trajectory(row));
  }

  loadRetrospective(sourceId: string): BtccRetrospective | null {
    return this.loadJson<BtccRetrospective>(
      "SELECT retrospective_json AS value FROM btcc_retrospectives WHERE source_id = ?",
      sourceId,
    );
  }

  saveRetrospective(value: BtccRetrospective): void {
    this.db.query(`
      INSERT OR IGNORE INTO btcc_retrospectives (source_id, retrospective_json, created_at)
      VALUES (?, ?, ?)
    `).run(value.sourceId, JSON.stringify(value), new Date().toISOString());
  }

  loadDecisions(sourceId: string): RetrospectiveDecisionSet | null {
    return this.loadJson<RetrospectiveDecisionSet>(
      "SELECT decisions_json AS value FROM btcc_retrospective_decisions WHERE source_id = ?",
      sourceId,
    );
  }

  saveDecisions(value: RetrospectiveDecisionSet): void {
    this.db.query(`
      INSERT OR IGNORE INTO btcc_retrospective_decisions (source_id, decisions_json, created_at)
      VALUES (?, ?, ?)
    `).run(value.sourceId, JSON.stringify(value), new Date().toISOString());
  }

  loadAcceptedGuidance(
    trajectory: BtccTrajectory,
    phases: ModelPhaseState[],
  ): AcceptedPhaseGuidance[] {
    const seen = new Set<string>();
    return [...new Set(phases)].flatMap((phase) =>
      this.guidance.list({
        phase,
        userRef: trajectory.userRef,
        ...(trajectory.projectRef ? { projectRef: trajectory.projectRef } : {}),
      }).filter((entry) => {
        const key = `${entry.guidanceId}:${entry.phase}:${entry.scope.kind}:${entry.revision}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    );
  }

  publishGuidance(
    input: Omit<AcceptedPhaseGuidance, "revision" | "contentSha256">,
  ): AcceptedPhaseGuidance {
    return this.guidance.publish(input);
  }

  markProcessed(outboxId: string): void {
    this.db.transaction(() => {
      this.db.query(`
        UPDATE btcc_learning_candidate_outbox SET status = 'processed'
        WHERE outbox_id = ? AND status = 'pending'
      `).run(outboxId);
      this.db.query("DELETE FROM btcc_learning_diagnostics WHERE outbox_id = ?").run(outboxId);
    })();
  }

  recordFailure(outboxId: string, error: string): void {
    this.db.query(`
      INSERT INTO btcc_learning_diagnostics (outbox_id, attempt_count, last_error, updated_at)
      VALUES (?, 1, ?, ?)
      ON CONFLICT(outbox_id) DO UPDATE SET
        attempt_count = attempt_count + 1,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).run(outboxId, error.slice(0, 2_000), new Date().toISOString());
  }

  close(): void {
    this.db.close();
  }

  private trajectory(row: PendingRow): BtccTrajectory {
    const source = parseRecord(row.source_json, "learning source");
    const context = parseRecord(row.context_json, "turn context");
    const turnId = requiredString(source.turnId, "learning source turnId");
    const feedbackRefs = stringArray(source.recentFeedbackRefs);
    return {
      sourceId: row.source_id,
      outboxId: row.outbox_id,
      turnId,
      userRef: requiredString(context.userRef, "turn userRef"),
      ...(typeof context.projectRef === "string" ? { projectRef: context.projectRef } : {}),
      originalRequest: row.original_message,
      goalContract: this.recordForRef(source.goalContractRef),
      phaseProducts: this.checkpoints(turnId),
      finalDossier: this.recordForRef(source.finalDossierRef),
      finalPayload: JSON.parse(row.final_payload_json),
      recentFeedback: feedbackRefs.flatMap((ref) => {
        const content = this.contextContent(ref);
        return content === null ? [] : [{ ref, content }];
      }),
    };
  }

  private checkpoints(turnId: string): BtccTrajectory["phaseProducts"] {
    return this.db.query<CheckpointRow, [string]>(`
      SELECT semantic_state, turn_revision, accepted_product_json
      FROM btcc_checkpoints
      WHERE turn_id = ? AND accepted_product_json IS NOT NULL
      ORDER BY turn_revision ASC
    `).all(turnId).map((row) => ({
      semanticState: row.semantic_state,
      turnRevision: row.turn_revision,
      acceptedProduct: JSON.parse(row.accepted_product_json),
    }));
  }

  private recordForRef(value: unknown): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const id = (value as { id?: unknown }).id;
    if (typeof id !== "string") return undefined;
    return this.loadJson<unknown>(
      "SELECT content_json AS value FROM btcc_records WHERE record_id = ?",
      id,
    ) ?? undefined;
  }

  private contextContent(ref: string): string | null {
    const row = this.db.query<{ content: string }, [string]>(
      "SELECT content FROM btcc_context_documents WHERE context_ref = ?",
    ).get(ref);
    return row?.content ?? null;
  }

  private loadJson<T>(sql: string, id: string): T | null {
    const row = this.db.query<JsonRow, [string]>(sql).get(id);
    return row ? JSON.parse(row.value) as T : null;
  }

  private reconcileMissingSources(): void {
    const rows = this.db.query<MissingSourceRow, []>(`
      SELECT t.turn_id, t.final_payload_json, t.managed_state_json,
             t.opening_answer_json, t.context_json
      FROM btcc_turns t
      LEFT JOIN btcc_learning_sources s ON s.turn_id = t.turn_id
      WHERE t.semantic_state = 'delivered'
        AND t.final_payload_json IS NOT NULL
        AND s.source_id IS NULL
    `).all();
    for (const row of rows) this.reconcileSource(row);
  }

  private reconcileSource(row: MissingSourceRow): void {
    const finalPayload = parseRecord(row.final_payload_json, "final payload");
    const managed = optionalRecord(row.managed_state_json);
    const opening = optionalRecord(row.opening_answer_json);
    const context = parseRecord(row.context_json, "turn context");
    const finalPayloadRef = recordPath(finalPayload, ["ref"]);
    if (!finalPayloadRef) return;
    const sourceId = digest(
      `btcc-learning-source.v1\0${row.turn_id}\0${requiredString(finalPayloadRef.sha256, "payload sha256")}`,
    );
    const goalContractRef = recordPath(managed, ["goalAcceptance", "goalContract", "ref"]) ??
      recordPath(opening, ["goalContract", "ref"]);
    const finalDossierRef = recordPath(managed, ["finalDossier", "dossier", "ref"]);
    const source = {
      sourceId,
      turnId: row.turn_id,
      finalPayloadRef,
      ...(goalContractRef ? { goalContractRef } : {}),
      ...(finalDossierRef ? { finalDossierRef } : {}),
      reviewReceiptRefs: reviewReceiptRefs(managed),
      recentFeedbackRefs: stringArray(context.recentFeedbackRefs),
    };
    this.db.transaction(() => {
      this.db.query(`
        INSERT OR IGNORE INTO btcc_learning_sources (
          source_id, turn_id, final_payload_ref, source_json
        ) VALUES (?, ?, ?, ?)
      `).run(sourceId, row.turn_id, stableJson(finalPayloadRef), stableJson(source));
      this.db.query(`
        INSERT OR IGNORE INTO btcc_learning_candidate_outbox (outbox_id, source_id, status)
        VALUES (?, ?, 'pending')
      `).run(digest(`btcc-learning-outbox.v1\0${sourceId}`), sourceId);
    })();
  }
}

function parseRecord(value: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be an object`);
  }
  return parsed as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is missing`);
  return value;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function optionalRecord(value: string | null): Record<string, unknown> | null {
  return value ? parseRecord(value, "optional BTCC record") : null;
}

function recordPath(
  value: Record<string, unknown> | null,
  path: string[],
): Record<string, unknown> | null {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return current && typeof current === "object" && !Array.isArray(current)
    ? current as Record<string, unknown>
    : null;
}

function reviewReceiptRefs(managed: Record<string, unknown> | null): unknown[] {
  const program = recordPath(managed, ["program"]);
  const tasks = program?.tasks;
  if (!Array.isArray(tasks)) return [];
  return tasks.flatMap((task) => {
    if (!task || typeof task !== "object" || Array.isArray(task)) return [];
    const review = recordPath(task as Record<string, unknown>, ["currentReview", "review", "ref"]);
    return review ? [review] : [];
  });
}
