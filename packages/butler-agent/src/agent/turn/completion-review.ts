import type {
  EvidenceCapabilityReceipt,
  EvidenceCapabilityReference,
} from "../output/evidence/types.ts";
import { parseEvidenceCapabilityReceipt } from "../output/evidence/parser.ts";
import { normalizeEvidenceCapabilityReceipts } from "../output/evidence/ledger-state.ts";
import type { PublicWorkObligationKind } from "./native/output/tool-types.ts";

export type CompletionReviewStatus = "complete" | "gap" | "waiting_user" | "failed";

export type CompletionReviewObservationVisibility = "model" | "public" | "operator";

export type CompletionReviewObservationKind =
  | "completion_gap"
  | "public_decision_required"
  | "tool_result"
  | "tool_invalid_arguments"
  | "tool_unavailable"
  | "command_failed"
  | "test_failed"
  | "validation_failed"
  | "context_compacted"
  | "user_input"
  | "user_cancelled";

export interface CompletionReviewObservationRef {
  kind: string;
  id: string;
  path?: string;
}

export interface CompletionReviewObservation {
  kind: CompletionReviewObservationKind;
  visibility: CompletionReviewObservationVisibility;
  summary: string;
  modelVisibleContent: string;
  publicSummary?: string;
  refs?: CompletionReviewObservationRef[];
  causedByToolCallId?: string;
  causedByDecisionId?: string;
}

export interface CompletionReviewInput {
  requestText: string;
  candidateText: string;
  evidenceReceipts?: readonly unknown[];
  requiredObligations?: readonly PublicWorkObligationKind[];
  observations?: ReadonlyArray<Pick<
    CompletionReviewObservation,
    "kind" | "summary" | "modelVisibleContent"
  > & {
    visibility?: CompletionReviewObservationVisibility;
    publicSummary?: string;
  }>;
  workStreamTerminal?: boolean;
  todoTerminal?: boolean;
}

export interface CompletionReviewComplete {
  status: "complete";
  evidenceRefs: string[];
}

export interface CompletionReviewGap {
  status: "gap";
  observation: CompletionReviewObservation;
  evidenceRefs: string[];
}

export interface CompletionReviewWaitingUser {
  status: "waiting_user";
  question: string;
  evidenceRefs: string[];
}

export interface CompletionReviewFailed {
  status: "failed";
  publicSummary: string;
  evidenceRefs: string[];
}

export type CompletionReviewOutcome =
  | CompletionReviewComplete
  | CompletionReviewGap
  | CompletionReviewWaitingUser
  | CompletionReviewFailed;

const DEFAULT_PUBLIC_SUMMARY = "Missing completion evidence.";
const TEXT_TRUNCATE = 180;
const OBSERVATION_KIND_SET = new Set<string>([
  "completion_gap",
  "public_decision_required",
  "tool_result",
  "tool_invalid_arguments",
  "tool_unavailable",
  "command_failed",
  "test_failed",
  "validation_failed",
  "context_compacted",
  "user_input",
  "user_cancelled",
]);

export function evaluateCompletionReviewOutcome(input: CompletionReviewInput): CompletionReviewOutcome {
  const {
    requestText,
    candidateText,
    evidenceReceipts = [],
    requiredObligations = [],
    observations = [],
    workStreamTerminal = false,
    todoTerminal = false,
  } = input;

  const request = trimSafeText(requestText);
  const candidate = trimSafeText(candidateText);

  if (!request) {
    return buildFailedOutcome({
      publicSummary: "Could not evaluate completion without request text.",
      evidenceRefs: collectEvidenceRefsFromUnknownReceipts(evidenceReceipts),
    });
  }

  const required = dedupe(requiredObligations);
  if (!required.length) {
    return {
      status: "complete",
      evidenceRefs: collectEvidenceRefsFromUnknownReceipts(evidenceReceipts),
    };
  }

  const hasBlockingObservation = hasBlockingObservationKind(observations);
  const requiredSet = new Set(required);
  const {
    claimsByObligation,
    hasExplicitBlocker,
    explicitBlockerEvidenceRefs,
  } = collectReceiptClaims(evidenceReceipts, requiredSet);
  const contradictionObligations = new Set<PublicWorkObligationKind>();
  const missing = new Set<PublicWorkObligationKind>(required);
  const observationEvidenceRefs = collectObservationRefIds(observations);
  let explicitBlocker = false;
  const latestEvidenceRefs = new Set<string>(observationEvidenceRefs);
  for (const ref of explicitBlockerEvidenceRefs) latestEvidenceRefs.add(ref);

  for (const obligation of required) {
    const claims = claimsByObligation.get(obligation);
    if (!claims?.length) {
      continue;
    }
    for (const claim of claims) {
      for (const evidenceRef of claim.evidenceRefs) latestEvidenceRefs.add(evidenceRef);
    }
    const hasSatisfied = claims.some((claim) => claim.status === "satisfied");
    const hasFailed = claims.some((claim) => claim.status === "failed");
    const latest = latestClaim(claims);
    if (latest?.isExplicitBlocker) explicitBlocker = true;
    if (hasSatisfied) {
      missing.delete(obligation);
    }
    if (hasSatisfied && hasFailed) {
      contradictionObligations.add(obligation);
    }
    if (latest && latest.status !== "satisfied") {
      if (latest.status === "failed") {
        // keep obligation missing to force explicit gap/fail state
        // even when previous rows claimed satisfaction.
      }
    }
  }

  const evidenceRefs = [...latestEvidenceRefs];
  if (!missing.size) {
    if (contradictionObligations.size > 0) {
      return buildGapOutcome({
        status: decideNonCompleteStatus({
          isTerminal: workStreamTerminal || todoTerminal,
          blockingObservation: hasBlockingObservation,
          explicitBlocker: false,
        }),
        requestText: request,
        candidateText: candidate,
        summary: buildContradictionSummary([...contradictionObligations]),
        evidenceRefs,
        observations,
      });
    }
    return {
      status: "complete",
      evidenceRefs,
    };
  }

  return buildGapOutcome({
    status: decideNonCompleteStatus({
      isTerminal: workStreamTerminal || todoTerminal,
      blockingObservation: hasBlockingObservation,
      explicitBlocker: explicitBlocker || hasExplicitBlocker,
    }),
    requestText: request,
    candidateText: candidate,
    summary: buildMissingSummary([...missing]),
    evidenceRefs,
    observations,
  });
}

interface ParsedClaim {
  evidenceRefs: string[];
  status: "satisfied" | "failed";
  isExplicitBlocker: boolean;
  obligation: PublicWorkObligationKind;
  createdAt: number;
}

interface EvidenceInputRecord {
  receiptId: string;
  references: EvidenceCapabilityReference[];
  verified: boolean;
  maturity: string;
  capability: string;
  evidenceKind: string;
  createdAt: number;
}

interface ReceiptClaimBundle {
  claimsByObligation: Map<PublicWorkObligationKind, ParsedClaim[]>;
  hasExplicitBlocker: boolean;
  explicitBlockerEvidenceRefs: string[];
}

function collectReceiptClaims(
  receipts: readonly unknown[],
  requiredSet: Set<PublicWorkObligationKind>,
): ReceiptClaimBundle {
  const result = new Map<PublicWorkObligationKind, ParsedClaim[]>();
  let hasExplicitBlocker = false;
  const explicitBlockerEvidenceRefs = new Set<string>();
  for (const raw of receipts) {
    const parsed = parseEvidenceCapabilityReceipt(raw);
    if (parsed.ok) {
      const receipt = parsed.receipt;
      if (isExplicitBlockerReceipt(receipt)) {
        hasExplicitBlocker = true;
        for (const ref of buildEvidenceRefs(receipt.receipt_id, receipt.references)) {
          explicitBlockerEvidenceRefs.add(ref);
        }
      }
      processNormalizedReceipt(receipt, requiredSet, result);
      continue;
    }
    processFailedReceipt(raw, requiredSet, result);
  }
  return {
    claimsByObligation: result,
    hasExplicitBlocker,
    explicitBlockerEvidenceRefs: [...explicitBlockerEvidenceRefs],
  };
}

function processFailedReceipt(
  raw: unknown,
  requiredSet: Set<PublicWorkObligationKind>,
  result: Map<PublicWorkObligationKind, ParsedClaim[]>,
): void {
  const record = recordValue(raw);
  if (!record || stringValue(record.schema_version) !== "evidence-capability.v1") {
    return;
  }

  const matches = readObligations(record.satisfies, requiredSet);
  if (!matches.length) return;

  const receiptId = stringValue(record.receipt_id);
  if (!receiptId) return;

  const capability = stringValue(record.capability) ?? "";
  const evidenceKind = stringValue(record.evidence_kind) ?? "";
  const verified = typeof record.verified === "boolean" ? record.verified : false;
  const maturity = stringValue(record.maturity) ?? "candidate";
  const createdAt = parseCreatedAt(stringValue(record.created_at) ?? "");
  const references = parseReferencesFromUnknown(record.references);

  for (const obligation of matches) {
    const claim: ParsedClaim = {
      obligation,
      evidenceRefs: buildEvidenceRefs(receiptId, references),
      status: evaluateReceiptClaimStatus({
        receiptId,
        references,
        verified,
        maturity,
        capability,
        evidenceKind,
        createdAt,
      }),
      isExplicitBlocker: capability === "explicit_blocker" && evidenceKind === "blocker" && verified && maturity === "verified",
      createdAt,
    };
    const list = result.get(obligation) ?? [];
    list.push(claim);
    result.set(obligation, list);
  }
}

function readObligations(
  value: unknown,
  requiredSet: Set<PublicWorkObligationKind>,
): PublicWorkObligationKind[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const obligations: PublicWorkObligationKind[] = [];
  for (const item of value) {
    const text = stringValue(item);
    if (text && requiredSet.has(text as PublicWorkObligationKind)) {
      obligations.push(text as PublicWorkObligationKind);
    }
  }
  return [...new Set(obligations)];
}

function parseReferencesFromUnknown(value: unknown): EvidenceCapabilityReference[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((reference) => {
      const record = recordValue(reference);
      if (!record) return null;
      const url = stringValue(record.url);
      const path = stringValue(record.path);
      const artifactId = stringValue(record.artifact_id);
      const toolCallId = stringValue(record.tool_call_id);
      const taskId = stringValue(record.task_id);
      const entry: EvidenceCapabilityReference = {
        ...(url ? { url } : {}),
        ...(path ? { path } : {}),
        ...(artifactId ? { artifact_id: artifactId } : {}),
        ...(toolCallId ? { tool_call_id: toolCallId } : {}),
        ...(taskId ? { task_id: taskId } : {}),
      };
      return Object.keys(entry).length > 0 ? entry : null;
    })
    .filter((entry): entry is EvidenceCapabilityReference => entry !== null);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function processNormalizedReceipt(
  receipt: EvidenceCapabilityReceipt,
  requiredSet: Set<PublicWorkObligationKind>,
  result: Map<PublicWorkObligationKind, ParsedClaim[]>,
): void {
  const matched = (receipt.satisfies ?? []).filter((obligation) => requiredSet.has(obligation));
  for (const obligation of matched) {
    const input: EvidenceInputRecord = {
      receiptId: receipt.receipt_id,
      references: receipt.references,
      verified: receipt.verified,
      maturity: receipt.maturity,
      capability: receipt.capability,
      evidenceKind: receipt.evidence_kind,
      createdAt: parseCreatedAt(receipt.created_at),
    };
    const claim: ParsedClaim = {
      obligation,
      evidenceRefs: buildEvidenceRefs(input.receiptId, input.references),
      status: evaluateReceiptClaimStatus(input),
      isExplicitBlocker: isExplicitBlockerReceipt(receipt),
      createdAt: input.createdAt,
    };
    const list = result.get(obligation) ?? [];
    list.push(claim);
    result.set(obligation, list);
  }
}

function latestClaim(claims: ParsedClaim[]): ParsedClaim | null {
  if (!claims.length) return null;
  const ordered = [...claims].sort((a, b) => a.createdAt - b.createdAt);
  return ordered.at(-1) ?? null;
}

function evaluateReceiptClaimStatus(input: EvidenceInputRecord): "satisfied" | "failed" {
  if (!input.verified || input.maturity !== "verified") return "failed";
  return isEvidenceCompatible(input.capability, input.evidenceKind, input.references)
    ? "satisfied"
    : "failed";
}

function isExplicitBlockerReceipt(receipt: EvidenceCapabilityReceipt): boolean {
  return receipt.capability === "explicit_blocker" &&
    receipt.evidence_kind === "blocker" &&
    receipt.verified &&
    receipt.maturity === "verified";
}

function isEvidenceCompatible(
  capability: string,
  evidenceKind: string,
  references: EvidenceCapabilityReference[],
): boolean {
  if (capability === "source_verified") {
    if (evidenceKind === "source_page") {
      return references.some((reference) => Boolean(reference.url && /^https?:\/\//u.test(reference.url)));
    }
    return evidenceKind === "workspace_inspection" ||
      evidenceKind === "project_state";
  }
  if (capability === "command_executed") {
    return evidenceKind === "execution_result";
  }
  if (capability === "durable_artifact") {
    return evidenceKind === "artifact" || evidenceKind === "workspace_inspection";
  }
  if (capability === "data_table_created") {
    return evidenceKind === "data_table" || evidenceKind === "artifact";
  }
  if (capability === "chart_rendered") {
    return evidenceKind === "chart" || evidenceKind === "artifact";
  }
  return false;
}

interface GapInput {
  status: Exclude<CompletionReviewStatus, "complete">;
  requestText: string;
  candidateText: string;
  summary: string;
  evidenceRefs: string[];
  observations?: CompletionReviewInput["observations"];
}

function buildGapOutcome(input: GapInput): CompletionReviewOutcome {
  if (input.status === "failed") {
    return {
      status: "failed",
      publicSummary: input.summary,
      evidenceRefs: input.evidenceRefs,
    };
  }

  const question = input.summary || DEFAULT_PUBLIC_SUMMARY;
  if (input.status === "waiting_user") {
    return {
      status: "waiting_user",
      question,
      evidenceRefs: input.evidenceRefs,
    };
  }

  return {
    status: "gap",
    observation: {
      kind: "completion_gap",
      visibility: "model",
      summary: question,
      modelVisibleContent: buildGapModelText({
        requestText: input.requestText,
        candidateText: input.candidateText,
        summary: input.summary || DEFAULT_PUBLIC_SUMMARY,
      }),
      publicSummary: DEFAULT_PUBLIC_SUMMARY,
      refs: collectObservationRefsFromInput(input.observations),
    },
    evidenceRefs: input.evidenceRefs,
  };
}

function buildFailedOutcome(input: { publicSummary: string; evidenceRefs: string[] }): CompletionReviewFailed {
  return {
    status: "failed",
    publicSummary: input.publicSummary || DEFAULT_PUBLIC_SUMMARY,
    evidenceRefs: input.evidenceRefs,
  };
}

function buildMissingSummary(missing: string[]): string {
  if (missing.length === 0) return DEFAULT_PUBLIC_SUMMARY;
  return `Missing completion evidence for: ${missing.join(", ")}.`;
}

function buildContradictionSummary(obligations: PublicWorkObligationKind[]): string {
  return `Conflicting completion evidence rows exist for: ${obligations.join(", ")}.`;
}

function buildGapModelText(input: {
  requestText: string;
  candidateText: string;
  summary: string;
}) {
  const candidate = input.candidateText ? truncate(input.candidateText, TEXT_TRUNCATE) : "";
  return [
    `request: ${input.requestText}`,
    candidate ? `candidate: ${candidate}` : "candidate: <empty>",
    `next-step: ${input.summary}`,
  ].join("\n");
}

function hasBlockingObservationKind(observations: CompletionReviewInput["observations"] = []): boolean {
  return observations.some((observation) =>
    observation.kind === "public_decision_required" || observation.kind === "user_cancelled"
  );
}

function decideNonCompleteStatus(input: {
  isTerminal: boolean;
  blockingObservation: boolean;
  explicitBlocker: boolean;
}): Exclude<CompletionReviewStatus, "complete"> {
  if (input.isTerminal) return "failed";
  if (input.blockingObservation || input.explicitBlocker) return "waiting_user";
  return "gap";
}

function collectEvidenceRefsFromUnknownReceipts(receipts: readonly unknown[]): string[] {
  const refs = new Set<string>();
  for (const raw of receipts) {
    const normalized = normalizeEvidenceCapabilityReceipts(raw);
    for (const receipt of normalized.receipts) {
      for (const ref of buildEvidenceRefs(receipt.receipt_id, receipt.references)) {
        refs.add(ref);
      }
    }
  }
  return [...refs];
}

function collectObservationRefsFromInput(
  observations?: CompletionReviewInput["observations"],
): CompletionReviewObservationRef[] {
  if (!observations?.length) return [];
  const refs: CompletionReviewObservationRef[] = [];
  for (const [index, observation] of observations.entries()) {
    if (!OBSERVATION_KIND_SET.has(observation.kind)) continue;
    refs.push({
      kind: observation.kind,
      id: `observation:${index + 1}`,
    });
  }
  return refs;
}

function collectObservationRefIds(observations?: CompletionReviewInput["observations"]): string[] {
  return collectObservationRefsFromInput(observations).map((ref) => `${ref.id}`);
}

function buildEvidenceRefs(receiptId: string, references: EvidenceCapabilityReference[]): string[] {
  const refs = new Set<string>([`receipt:${receiptId}`]);
  for (const ref of references) {
    if (ref.path) refs.add(`path:${ref.path}`);
    if (ref.url) refs.add(`url:${ref.url}`);
    if (ref.artifact_id) refs.add(`artifact:${ref.artifact_id}`);
    if (ref.task_id) refs.add(`task:${ref.task_id}`);
    if (ref.tool_call_id) refs.add(`tool:${ref.tool_call_id}`);
  }
  return [...refs];
}

function parseCreatedAt(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dedupe<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function trimSafeText(value: string): string {
  return (value ?? "").trim();
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}
