import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { AgentConversationStore } from "../../conversation/store.ts";
import type { ConversationMessageWithParts } from "../../conversation/types.ts";
import { textForMessage } from "../../context/conversation-context-format.ts";
import { cognitionMemoryRoot } from "../paths.ts";
import {
  hotCacheContentHash,
  restoreHotCacheSnapshot,
  semanticHotCachePath,
  writeSemanticHotCacheEntry,
} from "./hot-cache-writer.ts";
import type { ConversationCompletionObservation } from "./completion-observation.ts";

export const CONTINUITY_RECOVERY_MANIFEST_SCHEMA =
  "butler.continuity-recovery-manifest.v1" as const;

export interface ContinuityRecoveryCandidate {
  candidate_id: string;
  project_id: string;
  conversation_session_id: string;
  conversation_turn_id: string;
  inbound_message_id: string;
  outbound_message_id: string;
  completed_at: string;
  preview: string;
  body: string;
  body_sha256: string;
}

export interface ContinuityRecoveryManifest {
  schema_version: typeof CONTINUITY_RECOVERY_MANIFEST_SCHEMA;
  manifest_id: string;
  project_id: string;
  status: "dry_run" | "approved" | "applied" | "rolled_back";
  created_at: string;
  updated_at: string;
  inventory_by_project: Record<string, number>;
  candidates: ContinuityRecoveryCandidate[];
  approved_candidate_ids: string[];
  quarantine: Array<{
    conversation_session_id: string;
    conversation_turn_id: string;
    reason:
      | "missing_project_provenance"
      | "secret_or_credential_risk"
      | "incomplete_canonical_turn";
  }>;
  before: { path: string; bytes: number; sha256: string; body_base64: string };
  after: { bytes: number; sha256: string } | null;
}

export interface ContinuityRecoveryManifestView {
  manifest_id: string;
  project_id: string;
  status: ContinuityRecoveryManifest["status"];
  inventory_by_project: Record<string, number>;
  candidate_count: number;
  approved_count: number;
  quarantine_count: number;
  before: { path: string; bytes: number; sha256: string };
  after: ContinuityRecoveryManifest["after"];
  candidates: Array<Omit<ContinuityRecoveryCandidate, "body">>;
  quarantine: ContinuityRecoveryManifest["quarantine"];
}

export function planContinuityRecovery(input: {
  butlerData: string;
  projectId: string;
  now?: string;
}): ContinuityRecoveryManifest {
  const projectId = input.projectId.trim();
  if (!projectId) throw new Error("continuity_recovery_project_required");
  const path = semanticHotCachePath({
    butlerData: input.butlerData,
    scope: "project",
    projectId,
  });
  const beforeBody = readText(path);
  const inventory = inventoryCanonicalTurns(input.butlerData);
  const processedTurns = processedCompletionTurnIds(input.butlerData);
  const candidates: ContinuityRecoveryCandidate[] = [];
  const quarantine: ContinuityRecoveryManifest["quarantine"] = [];
  const inventoryByProject: Record<string, number> = {};
  for (const turn of inventory) {
    const owner = turn.projectId ?? "unscoped";
    inventoryByProject[owner] = (inventoryByProject[owner] ?? 0) + 1;
    if (!turn.projectId) {
      quarantine.push({
        conversation_session_id: turn.sessionId,
        conversation_turn_id: turn.turnId,
        reason: "missing_project_provenance",
      });
      continue;
    }
    if (turn.projectId !== projectId || processedTurns.has(turn.turnId))
      continue;
    const candidate = recoveryCandidate(turn);
    if (candidate === "incomplete") {
      quarantine.push({
        conversation_session_id: turn.sessionId,
        conversation_turn_id: turn.turnId,
        reason: "incomplete_canonical_turn",
      });
    } else if (candidate === "secret") {
      quarantine.push({
        conversation_session_id: turn.sessionId,
        conversation_turn_id: turn.turnId,
        reason: "secret_or_credential_risk",
      });
    } else {
      candidates.push(candidate);
    }
  }
  candidates.sort(
    (left, right) =>
      left.completed_at.localeCompare(right.completed_at) ||
      left.candidate_id.localeCompare(right.candidate_id),
  );
  quarantine.sort((left, right) =>
    left.conversation_turn_id.localeCompare(right.conversation_turn_id),
  );
  const beforeHash = hotCacheContentHash(beforeBody);
  const manifestId = `crm_${createHash("sha256")
    .update(
      `${projectId}\0${beforeHash}\0${candidates.map((candidate) => candidate.candidate_id).join("\0")}`,
    )
    .digest("hex")
    .slice(0, 32)}`;
  const existing = readContinuityRecoveryManifest(input.butlerData, manifestId);
  if (existing) return existing;
  const now = input.now ?? new Date().toISOString();
  const manifest: ContinuityRecoveryManifest = {
    schema_version: CONTINUITY_RECOVERY_MANIFEST_SCHEMA,
    manifest_id: manifestId,
    project_id: projectId,
    status: "dry_run",
    created_at: now,
    updated_at: now,
    inventory_by_project: Object.fromEntries(
      Object.entries(inventoryByProject).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    candidates,
    approved_candidate_ids: [],
    quarantine,
    before: {
      path,
      bytes: Buffer.byteLength(beforeBody, "utf8"),
      sha256: beforeHash,
      body_base64: Buffer.from(beforeBody, "utf8").toString("base64"),
    },
    after: null,
  };
  writeManifest(input.butlerData, manifest);
  return manifest;
}

export function approveContinuityRecovery(input: {
  butlerData: string;
  manifestId: string;
  candidateIds: readonly string[] | "all";
  now?: string;
}): ContinuityRecoveryManifest {
  const manifest = requireManifest(input.butlerData, input.manifestId);
  if (manifest.status === "applied" || manifest.status === "rolled_back") {
    throw new Error("continuity_recovery_manifest_terminal");
  }
  const available = new Set(
    manifest.candidates.map((candidate) => candidate.candidate_id),
  );
  const approved =
    input.candidateIds === "all"
      ? [...available]
      : [...new Set(input.candidateIds.map((id) => id.trim()).filter(Boolean))];
  if (approved.length === 0 || approved.some((id) => !available.has(id))) {
    throw new Error("continuity_recovery_candidate_invalid");
  }
  const updated: ContinuityRecoveryManifest = {
    ...manifest,
    status: "approved",
    approved_candidate_ids: approved.sort(),
    updated_at: input.now ?? new Date().toISOString(),
  };
  writeManifest(input.butlerData, updated);
  return updated;
}

export function applyContinuityRecovery(input: {
  butlerData: string;
  manifestId: string;
  now?: string;
}): { manifest: ContinuityRecoveryManifest; replayed: boolean } {
  const manifest = requireManifest(input.butlerData, input.manifestId);
  const current = readText(manifest.before.path);
  const currentHash = hotCacheContentHash(current);
  if (manifest.status === "applied" && manifest.after?.sha256 === currentHash) {
    return { manifest, replayed: true };
  }
  if (
    manifest.status !== "approved" ||
    manifest.approved_candidate_ids.length === 0
  ) {
    throw new Error("continuity_recovery_approval_required");
  }
  if (currentHash !== manifest.before.sha256)
    throw new Error("continuity_recovery_snapshot_conflict");
  const approved = new Set(manifest.approved_candidate_ids);
  try {
    for (const candidate of manifest.candidates) {
      if (!approved.has(candidate.candidate_id)) continue;
      writeSemanticHotCacheEntry({
        butlerData: input.butlerData,
        scope: "project",
        projectId: manifest.project_id,
        sessionId: candidate.conversation_session_id,
        sourceId: `recovery_${manifest.manifest_id}_${candidate.candidate_id}`,
        body: candidate.body,
        createdAt: candidate.completed_at,
      });
    }
  } catch (error) {
    restoreHotCacheSnapshot({ path: manifest.before.path, body: current });
    throw error;
  }
  const afterBody = readText(manifest.before.path);
  const updated: ContinuityRecoveryManifest = {
    ...manifest,
    status: "applied",
    updated_at: input.now ?? new Date().toISOString(),
    after: {
      bytes: Buffer.byteLength(afterBody, "utf8"),
      sha256: hotCacheContentHash(afterBody),
    },
  };
  writeManifest(input.butlerData, updated);
  return { manifest: updated, replayed: false };
}

export function rollbackContinuityRecovery(input: {
  butlerData: string;
  manifestId: string;
  now?: string;
}): { manifest: ContinuityRecoveryManifest; replayed: boolean } {
  const manifest = requireManifest(input.butlerData, input.manifestId);
  const current = readText(manifest.before.path);
  const currentHash = hotCacheContentHash(current);
  if (
    manifest.status === "rolled_back" &&
    currentHash === manifest.before.sha256
  ) {
    return { manifest, replayed: true };
  }
  if (manifest.status !== "applied" || !manifest.after)
    throw new Error("continuity_recovery_not_applied");
  if (currentHash !== manifest.after.sha256)
    throw new Error("continuity_recovery_rollback_conflict");
  restoreHotCacheSnapshot({
    path: manifest.before.path,
    body: Buffer.from(manifest.before.body_base64, "base64").toString("utf8"),
  });
  const updated: ContinuityRecoveryManifest = {
    ...manifest,
    status: "rolled_back",
    updated_at: input.now ?? new Date().toISOString(),
  };
  writeManifest(input.butlerData, updated);
  return { manifest: updated, replayed: false };
}

export function readContinuityRecoveryManifest(
  butlerData: string,
  manifestId: string,
): ContinuityRecoveryManifest | null {
  try {
    const value = JSON.parse(
      readFileSync(recoveryManifestPath(butlerData, manifestId), "utf8"),
    ) as ContinuityRecoveryManifest;
    return value.schema_version === CONTINUITY_RECOVERY_MANIFEST_SCHEMA &&
      value.manifest_id === manifestId
      ? value
      : null;
  } catch {
    return null;
  }
}

export function continuityRecoveryManifestView(
  manifest: ContinuityRecoveryManifest,
): ContinuityRecoveryManifestView {
  return {
    manifest_id: manifest.manifest_id,
    project_id: manifest.project_id,
    status: manifest.status,
    inventory_by_project: manifest.inventory_by_project,
    candidate_count: manifest.candidates.length,
    approved_count: manifest.approved_candidate_ids.length,
    quarantine_count: manifest.quarantine.length,
    before: {
      path: manifest.before.path,
      bytes: manifest.before.bytes,
      sha256: manifest.before.sha256,
    },
    after: manifest.after,
    candidates: manifest.candidates.map(
      ({ body: _body, ...candidate }) => candidate,
    ),
    quarantine: manifest.quarantine,
  };
}

interface CanonicalTurnInventory {
  sessionId: string;
  turnId: string;
  projectId: string | null;
  completedAt: string;
  messages: ConversationMessageWithParts[];
}

function inventoryCanonicalTurns(butlerData: string): CanonicalTurnInventory[] {
  const store = new AgentConversationStore({ butlerData });
  try {
    const messages: ConversationMessageWithParts[] = [];
    const pageSize = 1_000;
    for (let offset = 0; ; offset += pageSize) {
      const page = store.readCognitionMessages({
        roles: ["user", "assistant"],
        limit: pageSize,
        offset,
        includeCompacted: true,
        order: "asc",
      });
      messages.push(...page);
      if (page.length < pageSize) break;
    }
    const groups = new Map<string, ConversationMessageWithParts[]>();
    for (const message of messages) {
      if (!message.turn_id) continue;
      const group = groups.get(message.turn_id) ?? [];
      group.push(message);
      groups.set(message.turn_id, group);
    }
    return [...groups.entries()].flatMap(([turnId, turnMessages]) => {
      const turn = store.readTurn(turnId);
      if (!turn || turn.status !== "complete") return [];
      const session = store.getSession(turn.session_id);
      return [
        {
          sessionId: turn.session_id,
          turnId,
          projectId: session?.project_id ?? null,
          completedAt: turn.completed_at ?? turn.started_at,
          messages: turnMessages,
        },
      ];
    });
  } finally {
    store.close();
  }
}

function recoveryCandidate(
  turn: CanonicalTurnInventory,
): ContinuityRecoveryCandidate | "incomplete" | "secret" {
  const user = turn.messages.find((message) => message.role === "user");
  const assistant = [...turn.messages]
    .reverse()
    .find((message) => message.role === "assistant");
  if (!user || !assistant) return "incomplete";
  const userText = compact(textForMessage(user, false), 280);
  const assistantText = compact(textForMessage(assistant, false), 360);
  if (!userText || !assistantText) return "incomplete";
  const body = [
    "**Recovered Turn**",
    `- User objective: ${userText}`,
    `- Assistant outcome: ${assistantText}`,
    `- Provenance: conversation=${turn.sessionId}; turn=${turn.turnId}; inbound=${user.id}; outbound=${assistant.id}`,
  ].join("\n");
  if (containsSecret(body)) return "secret";
  const candidateId = `crc_${createHash("sha256").update(`${turn.turnId}\0${user.id}\0${assistant.id}`).digest("hex").slice(0, 24)}`;
  return {
    candidate_id: candidateId,
    project_id: turn.projectId!,
    conversation_session_id: turn.sessionId,
    conversation_turn_id: turn.turnId,
    inbound_message_id: user.id,
    outbound_message_id: assistant.id,
    completed_at: turn.completedAt,
    preview: compact(`${userText} -> ${assistantText}`, 240),
    body,
    body_sha256: hotCacheContentHash(body),
  };
}

function processedCompletionTurnIds(butlerData: string): Set<string> {
  const root = join(cognitionMemoryRoot(butlerData), "queue");
  const observations = join(root, "completion-observations");
  const receipts = join(root, "completion-receipts");
  if (!existsSync(observations) || !existsSync(receipts)) return new Set();
  const turns = new Set<string>();
  for (const file of readdirSync(observations).filter((name) =>
    name.endsWith(".json"),
  )) {
    try {
      const observation = JSON.parse(
        readFileSync(join(observations, file), "utf8"),
      ) as ConversationCompletionObservation;
      if (existsSync(join(receipts, `${safeId(observation.job_id)}.json`)))
        turns.add(observation.conversation_turn_id);
    } catch {
      // Corrupt completion state is not trusted as recovery exclusion evidence.
    }
  }
  return turns;
}

function requireManifest(
  butlerData: string,
  manifestId: string,
): ContinuityRecoveryManifest {
  const manifest = readContinuityRecoveryManifest(butlerData, manifestId);
  if (!manifest) throw new Error("continuity_recovery_manifest_not_found");
  return manifest;
}

function recoveryManifestPath(butlerData: string, manifestId: string): string {
  return join(
    cognitionMemoryRoot(butlerData),
    "recovery",
    "manifests",
    `${safeId(manifestId)}.json`,
  );
}

function writeManifest(
  butlerData: string,
  manifest: ContinuityRecoveryManifest,
): void {
  const path = recoveryManifestPath(butlerData, manifest.manifest_id);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function compact(value: string, max: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= max
    ? normalized
    : `${normalized.slice(0, Math.max(0, max - 3))}...`;
}

function containsSecret(value: string): boolean {
  return (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(value) ||
    /\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b/u.test(value) ||
    /\bAKIA[0-9A-Z]{16}\b/u.test(value) ||
    /\b(?:password|passwd|token|api[_ -]?key)\s*[:=]\s*[^\s]{8,}/iu.test(value)
  );
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 160);
}
