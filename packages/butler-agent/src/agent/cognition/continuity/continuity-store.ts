import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  addFeedbackEntry,
  resolveFeedbackEntry,
} from "../feedback/buffer.ts";
import { cognitionMemoryRoot } from "../paths.ts";
import { updateExplicitMemory } from "../memory/quality.ts";
import type {
  ContinuityKind,
  ContinuityOperation,
  ContinuityScope,
  ContinuityUpdate,
} from "../../turn/turn-contract-types.ts";
import { resolveCanonicalProjectWorkspace } from "./project-workspace.ts";
import { replaceManagedHotCacheSection } from "./hot-cache-writer.ts";
import {
  CONTINUITY_KINDS,
  CONTINUITY_OPERATIONS,
  CONTINUITY_SCOPES,
} from "../../turn/turn-contract-types.ts";

export const CONTINUITY_STORE_SCHEMA = "butler.continuity-store.v1" as const;
const MAX_UPDATES_PER_DECISION = 4;
const MAX_SUMMARY_CHARS = 500;
const MAX_CANDIDATES = 12;
const MANAGED_START = "<!-- butler-continuity:start -->";
const MANAGED_END = "<!-- butler-continuity:end -->";

export interface ContinuityProvenance {
  conversation_session_id: string;
  turn_id: string;
  inbound_message_id: string;
  runtime_session_id: string;
  project_id: string | null;
}

export interface ContinuityCandidate {
  continuity_id: string;
  scope: ContinuityScope;
  kind: ContinuityKind;
  summary: string;
}

export interface ContinuityMutationReceipt {
  schema_version: "butler.continuity-mutation-receipt.v1";
  mutation_id: string;
  continuity_id: string;
  operation: ContinuityOperation;
  scope: ContinuityScope;
  destination: "project_hot_cache" | "session_continuity" | "feedback_buffer" | "explicit_global_rule" | "global_hot_cache";
  replayed: boolean;
}

interface ContinuityEntryRow {
  continuity_id: string;
  scope: ContinuityScope;
  owner_ref: string;
  kind: ContinuityKind;
  status: "active" | "superseded" | "forgotten";
  summary: string;
  project_id: string | null;
  session_id: string;
  conversation_session_id: string;
  turn_id: string;
  inbound_message_id: string;
  decision_id: string;
  destination: ContinuityMutationReceipt["destination"];
  destination_ref: string | null;
  created_at: string;
  updated_at: string;
}

interface MutationRow {
  mutation_id: string;
  receipt_json: string;
  status: "pending" | "committed";
}

export function continuityStorePath(butlerData: string): string {
  return join(butlerData, "runtime", "continuity-store.sqlite");
}

export function sessionContinuityPath(butlerData: string, sessionId: string): string {
  const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
  return join(cognitionMemoryRoot(butlerData), "sessions", `${key}.md`);
}

export class ContinuityStore {
  private readonly db: Database;

  constructor(private readonly butlerData: string) {
    const path = continuityStorePath(butlerData);
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=FULL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS continuity_entries (
        continuity_id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        owner_ref TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        project_id TEXT,
        session_id TEXT NOT NULL,
        conversation_session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        inbound_message_id TEXT NOT NULL,
        decision_id TEXT NOT NULL,
        destination TEXT NOT NULL,
        destination_ref TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS continuity_entries_owner_status_idx
      ON continuity_entries(scope, owner_ref, status, updated_at);
      CREATE TABLE IF NOT EXISTS continuity_mutations (
        mutation_id TEXT PRIMARY KEY,
        receipt_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  listCandidates(input: {
    projectId?: string | null;
    sessionId: string;
    limit?: number;
  }): ContinuityCandidate[] {
    const limit = Math.max(1, Math.min(MAX_CANDIDATES, Math.floor(input.limit ?? MAX_CANDIDATES)));
    const owners: Array<[ContinuityScope, string]> = [
      ["session", input.sessionId],
      ["global", "global"],
      ...(input.projectId?.trim() ? [["project", input.projectId.trim()] as [ContinuityScope, string]] : []),
    ];
    const candidates = owners.flatMap(([scope, owner]) => this.db.query<ContinuityEntryRow, [string, string, number]>(`
      SELECT * FROM continuity_entries
      WHERE scope = ? AND owner_ref = ? AND status = 'active'
      ORDER BY updated_at DESC, continuity_id ASC
      LIMIT ?
    `).all(scope, owner, limit));
    return candidates
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.continuity_id.localeCompare(b.continuity_id))
      .slice(0, limit)
      .map((entry) => ({
        continuity_id: entry.continuity_id,
        scope: entry.scope,
        kind: entry.kind,
        summary: entry.summary,
      }));
  }

  apply(input: {
    decisionId: string;
    updates: readonly ContinuityUpdate[];
    candidateRefs: readonly string[];
    provenance: ContinuityProvenance;
    boundWorkspacePath?: string | null;
    now?: string;
  }): ContinuityMutationReceipt[] {
    if (input.updates.length > MAX_UPDATES_PER_DECISION) throw new Error("continuity_update_limit_exceeded");
    const normalized = input.updates.map(normalizeUpdate);
    return normalized.map((update) => this.applyOne({ ...input, update }));
  }

  private applyOne(input: {
    decisionId: string;
    update: ContinuityUpdate;
    candidateRefs: readonly string[];
    provenance: ContinuityProvenance;
    boundWorkspacePath?: string | null;
    now?: string;
  }): ContinuityMutationReceipt {
    const ownerRef = ownerFor(input.update.scope, input.provenance);
    const mutationId = mutationIdFor(input.decisionId, input.provenance.turn_id, input.update);
    const replay = this.db.query<MutationRow, [string]>(
      "SELECT mutation_id, receipt_json, status FROM continuity_mutations WHERE mutation_id = ?",
    ).get(mutationId);
    if (replay?.status === "committed") {
      return { ...(JSON.parse(replay.receipt_json) as ContinuityMutationReceipt), replayed: true };
    }
    this.validateOperation(input.update, input.provenance, new Set(input.candidateRefs));
    const now = input.now ?? new Date().toISOString();
    const target = input.update.target_ref
      ? this.db.query<ContinuityEntryRow, [string]>("SELECT * FROM continuity_entries WHERE continuity_id = ?")
        .get(input.update.target_ref)
      : null;
    const existing = input.update.operation === "upsert"
      ? this.db.query<ContinuityEntryRow, [string, string, string, string]>(`
          SELECT * FROM continuity_entries
          WHERE scope = ? AND owner_ref = ? AND kind = ? AND summary = ? AND status = 'active'
          LIMIT 1
        `).get(input.update.scope, ownerRef, input.update.kind, input.update.summary)
      : null;
    const continuityId = existing?.continuity_id ?? continuityIdFor(mutationId);
    const destination = routeDestination(input.update);
    const receipt: ContinuityMutationReceipt = {
      schema_version: "butler.continuity-mutation-receipt.v1",
      mutation_id: mutationId,
      continuity_id: input.update.operation === "forget" && target ? target.continuity_id : continuityId,
      operation: input.update.operation,
      scope: input.update.scope,
      destination,
      replayed: false,
    };
    const tx = this.db.transaction(() => {
      if (!existing && input.update.operation !== "forget") {
        this.db.query(`
          INSERT OR IGNORE INTO continuity_entries (
            continuity_id, scope, owner_ref, kind, status, summary, project_id, session_id,
            conversation_session_id, turn_id, inbound_message_id, decision_id, destination,
            destination_ref, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
        `).run(
          continuityId,
          input.update.scope,
          ownerRef,
          input.update.kind,
          input.update.summary,
          input.provenance.project_id,
          input.provenance.runtime_session_id,
          input.provenance.conversation_session_id,
          input.provenance.turn_id,
          input.provenance.inbound_message_id,
          input.decisionId,
          destination,
          now,
          now,
        );
      }
      if (target && input.update.operation !== "upsert") {
        this.db.query("UPDATE continuity_entries SET status = ?, updated_at = ? WHERE continuity_id = ?")
          .run(input.update.operation === "forget" ? "forgotten" : "superseded", now, target.continuity_id);
      }
      this.db.query(`
        INSERT INTO continuity_mutations (mutation_id, receipt_json, status, created_at, updated_at)
        VALUES (?, ?, 'pending', ?, ?)
        ON CONFLICT(mutation_id) DO UPDATE SET receipt_json = excluded.receipt_json, updated_at = excluded.updated_at
      `).run(mutationId, JSON.stringify(receipt), now, now);
    });
    tx();
    const destinationRef = this.projectDestination({
      destination,
      scope: input.update.scope,
      projectId: input.provenance.project_id,
      sessionId: input.provenance.runtime_session_id,
      boundWorkspacePath: input.boundWorkspacePath,
      target,
      continuityId,
      operation: input.update.operation,
      summary: input.update.summary,
      mutationId,
    });
    this.db.query("UPDATE continuity_entries SET destination_ref = ? WHERE continuity_id = ?")
      .run(destinationRef, continuityId);
    this.db.query("UPDATE continuity_mutations SET status = 'committed', updated_at = ? WHERE mutation_id = ?")
      .run(now, mutationId);
    return receipt;
  }

  private validateOperation(
    update: ContinuityUpdate,
    provenance: ContinuityProvenance,
    allowedCandidates: Set<string>,
  ): void {
    if (update.scope === "project" && !provenance.project_id) throw new Error("continuity_project_binding_missing");
    if (update.operation === "upsert") {
      if (update.target_ref) throw new Error("continuity_upsert_target_unexpected");
      return;
    }
    if (!update.target_ref || !allowedCandidates.has(update.target_ref)) {
      throw new Error("continuity_target_not_in_candidates");
    }
    const target = this.db.query<ContinuityEntryRow, [string]>(
      "SELECT * FROM continuity_entries WHERE continuity_id = ?",
    ).get(update.target_ref);
    if (!target || target.status !== "active") throw new Error("continuity_target_not_active");
    if (target.scope !== update.scope || target.owner_ref !== ownerFor(update.scope, provenance)) {
      throw new Error("continuity_target_scope_mismatch");
    }
  }

  private projectDestination(input: {
    destination: ContinuityMutationReceipt["destination"];
    scope: ContinuityScope;
    projectId: string | null;
    sessionId: string;
    boundWorkspacePath?: string | null;
    target: ContinuityEntryRow | null;
    continuityId: string;
    operation: ContinuityOperation;
    summary: string;
    mutationId: string;
  }): string | null {
    if (input.destination === "project_hot_cache") {
      const projectId = input.projectId;
      if (!projectId) throw new Error("continuity_project_binding_missing");
      const workspace = resolveCanonicalProjectWorkspace({
        butlerData: this.butlerData,
        projectId,
        boundWorkspacePath: input.boundWorkspacePath,
      });
      const path = join(workspace, ".butler", "hot-cache.md");
      this.renderManagedEntries(path, "project", projectId);
      return path;
    }
    if (input.destination === "session_continuity") {
      const path = sessionContinuityPath(this.butlerData, input.sessionId);
      this.renderManagedEntries(path, "session", input.sessionId);
      return path;
    }
    if (input.destination === "feedback_buffer") {
      if (input.target?.destination_ref?.startsWith("feedback:") && input.operation !== "upsert") {
        resolveFeedbackEntry(
          this.butlerData,
          input.target.destination_ref.slice("feedback:".length),
          input.operation === "forget" ? "discarded" : "superseded",
        );
      }
      if (input.operation === "forget") return null;
      const entry = addFeedbackEntry(this.butlerData, {
        text: input.summary,
        targetRef: input.mutationId,
        category: "model_selected_continuity",
        scope: input.scope,
        promotionTarget: "review",
        priority: "high",
      });
      return `feedback:${entry.feedback_id}`;
    }
    if (input.destination === "explicit_global_rule") {
      if (input.target?.destination_ref && input.operation !== "upsert") {
        rmSync(input.target.destination_ref, { force: true });
      }
      if (input.operation === "forget") return null;
      return updateExplicitMemory({
        butlerData: this.butlerData,
        update: { kind: "rule", text: input.summary, source: `continuity:${input.mutationId}` },
      }).path;
    }
    const path = join(cognitionMemoryRoot(this.butlerData), "hot", "cache.md");
    this.renderManagedEntries(path, "global", "global");
    return path;
  }

  private renderManagedEntries(path: string, scope: ContinuityScope, ownerRef: string): void {
    const rows = this.db.query<ContinuityEntryRow, [string, string]>(`
      SELECT * FROM continuity_entries
      WHERE scope = ? AND owner_ref = ? AND status = 'active'
      ORDER BY updated_at DESC, continuity_id ASC
      LIMIT 24
    `).all(scope, ownerRef);
    const managed = [
      MANAGED_START,
      "## Active Continuity",
      "Apply these model-selected continuity items to the next relevant turn. Each item is runtime-bound and provenance-backed.",
      ...rows.map((entry) => [
        `- [${entry.continuity_id}] ${entry.kind}: ${entry.summary}`,
        `  provenance: conversation=${entry.conversation_session_id}; turn=${entry.turn_id}; message=${entry.inbound_message_id}`,
      ].join("\n")),
      MANAGED_END,
    ].join("\n");
    replaceManagedHotCacheSection({
      butlerData: this.butlerData,
      path,
      startMarker: MANAGED_START,
      endMarker: MANAGED_END,
      content: managed,
    });
  }
}

export function listContinuityCandidates(input: {
  butlerData: string;
  projectId?: string | null;
  sessionId: string;
  limit?: number;
}): ContinuityCandidate[] {
  const store = new ContinuityStore(input.butlerData);
  try {
    return store.listCandidates(input);
  } finally {
    store.close();
  }
}

export function commitContinuityUpdates(input: {
  butlerData: string;
  decisionId: string;
  updates: readonly ContinuityUpdate[];
  candidateRefs: readonly string[];
  provenance: ContinuityProvenance;
  boundWorkspacePath?: string | null;
  now?: string;
}): ContinuityMutationReceipt[] {
  const store = new ContinuityStore(input.butlerData);
  try {
    return store.apply(input);
  } finally {
    store.close();
  }
}

export function validateContinuityUpdates(input: {
  updates: readonly ContinuityUpdate[];
  candidates: readonly ContinuityCandidate[];
  projectId?: string | null;
}): ContinuityUpdate[] {
  if (input.updates.length > MAX_UPDATES_PER_DECISION) throw new Error("continuity_update_limit_exceeded");
  const normalized = input.updates.map(normalizeUpdate);
  const candidates = new Map(input.candidates.map((candidate) => [candidate.continuity_id, candidate]));
  for (const update of normalized) {
    if (update.scope === "project" && !input.projectId?.trim()) {
      throw new Error("continuity_project_binding_missing");
    }
    if (update.operation === "upsert") {
      if (update.target_ref) throw new Error("continuity_upsert_target_unexpected");
      continue;
    }
    const candidate = update.target_ref ? candidates.get(update.target_ref) : null;
    if (!candidate) throw new Error("continuity_target_not_in_candidates");
    if (candidate.scope !== update.scope) throw new Error("continuity_target_scope_mismatch");
  }
  return normalized;
}

function normalizeUpdate(update: ContinuityUpdate): ContinuityUpdate {
  if (!CONTINUITY_SCOPES.includes(update.scope)) throw new Error("continuity_scope_invalid");
  if (!CONTINUITY_KINDS.includes(update.kind)) throw new Error("continuity_kind_invalid");
  if (!CONTINUITY_OPERATIONS.includes(update.operation)) throw new Error("continuity_operation_invalid");
  const summary = update.summary.replace(/\s+/gu, " ").trim();
  if (!summary || summary.length > MAX_SUMMARY_CHARS) throw new Error("continuity_summary_invalid");
  if (containsSecret(summary)) throw new Error("continuity_secret_rejected");
  return {
    scope: update.scope,
    kind: update.kind,
    operation: update.operation,
    summary,
    ...(update.target_ref?.trim() ? { target_ref: update.target_ref.trim() } : {}),
  };
}

function containsSecret(value: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(value) ||
    /\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b/u.test(value) ||
    /\bAKIA[0-9A-Z]{16}\b/u.test(value) ||
    /\b(?:password|passwd|token|api[_ -]?key)\s*[:=]\s*[^\s]{8,}/iu.test(value);
}

function ownerFor(scope: ContinuityScope, provenance: ContinuityProvenance): string {
  if (scope === "project") {
    if (!provenance.project_id) throw new Error("continuity_project_binding_missing");
    return provenance.project_id;
  }
  return scope === "session" ? provenance.runtime_session_id : "global";
}

function routeDestination(update: ContinuityUpdate): ContinuityMutationReceipt["destination"] {
  if (update.scope === "project") return "project_hot_cache";
  if (update.scope === "session") return "session_continuity";
  if (update.kind === "correction") return "feedback_buffer";
  if (["instruction", "constraint", "preference"].includes(update.kind)) return "explicit_global_rule";
  return "global_hot_cache";
}

function mutationIdFor(decisionId: string, turnId: string, update: ContinuityUpdate): string {
  const normalized = JSON.stringify({
    scope: update.scope,
    kind: update.kind,
    operation: update.operation,
    summary: update.summary,
    target_ref: update.target_ref ?? null,
  });
  return `cm_${createHash("sha256").update(`${turnId}\0${decisionId}\0${normalized}`).digest("hex").slice(0, 32)}`;
}

function continuityIdFor(mutationId: string): string {
  return `cu_${createHash("sha256").update(mutationId).digest("hex").slice(0, 24)}`;
}
