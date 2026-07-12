import { join } from "path";
import { createHash } from "crypto";
import {
  readJsonFile,
  withDurableFileLock,
  writeJsonFileAtomic,
} from "../../persistence/atomic-json-store.ts";
import {
  isPublicWebEvidenceItem,
  type PublicWebEvidenceItem,
} from "./public-web-evidence.ts";

const PUBLIC_WEB_EVIDENCE_BUNDLE_SCHEMA = "butler.public-web-evidence-bundle.v1" as const;
const MAX_CONTRACT_EVIDENCE_ITEMS = 32;

interface PublicWebEvidenceBundle {
  schema_version: typeof PUBLIC_WEB_EVIDENCE_BUNDLE_SCHEMA;
  contract_id: string;
  items: PublicWebEvidenceItem[];
  attempts: PublicWebEvidenceAttempt[];
  updated_at: string;
}

export interface PublicWebEvidenceAttempt {
  attempt_id: string;
  producer: "web_search" | "web_read";
  outcome: "evidence" | "no_result" | "empty";
  observed_at: string;
}

export interface PublicWebEvidenceContext {
  items: PublicWebEvidenceItem[];
  attempts: PublicWebEvidenceAttempt[];
}

export function publicWebEvidenceItemsFromResult(result: unknown): PublicWebEvidenceItem[] {
  const record = result && typeof result === "object" && !Array.isArray(result)
    ? result as Record<string, unknown>
    : null;
  return Array.isArray(record?.public_web_evidence_items)
    ? record.public_web_evidence_items.filter(isPublicWebEvidenceItem)
    : [];
}

export function persistPublicWebEvidenceForContract(input: {
  butlerData: string;
  contractId: string;
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
}): PublicWebEvidenceItem[] {
  const contractId = safeId(input.contractId);
  if (input.toolName !== "web_search" && input.toolName !== "web_read") return [];
  const producer = input.toolName;
  const incoming = publicWebEvidenceItemsFromResult(input.result);
  const path = bundlePath(input.butlerData, contractId);
  const bundle = withDurableFileLock({
    lockPath: `${path}.lock`,
    lockRoot: input.butlerData,
    ownerId: `public-web-evidence:${contractId}`,
    action: () => {
      const existing = readContext(path, contractId);
      const items = [...new Map(
        [...existing.items, ...incoming].map((item) => [item.evidence_item_id, item]),
      ).values()].slice(-MAX_CONTRACT_EVIDENCE_ITEMS);
      const attempt = evidenceAttempt(producer, input.args, input.result, incoming);
      const attempts = [...new Map(
        [...existing.attempts, attempt].map((item) => [item.attempt_id, item]),
      ).values()].slice(-MAX_CONTRACT_EVIDENCE_ITEMS);
      const next: PublicWebEvidenceBundle = {
        schema_version: PUBLIC_WEB_EVIDENCE_BUNDLE_SCHEMA,
        contract_id: contractId,
        items,
        attempts,
        updated_at: new Date().toISOString(),
      };
      writeJsonFileAtomic(path, next);
      return next;
    },
  });
  if (!bundle) throw new Error("public_web_evidence_store_conflict");
  return bundle.items;
}

export function readPublicWebEvidenceForContract(input: {
  butlerData: string;
  contractId: string;
}): PublicWebEvidenceItem[] {
  return readPublicWebEvidenceContextForContract(input).items;
}

export function readPublicWebEvidenceContextForContract(input: {
  butlerData: string;
  contractId: string;
}): PublicWebEvidenceContext {
  const contractId = safeId(input.contractId);
  return readContext(bundlePath(input.butlerData, contractId), contractId);
}

function readContext(path: string, contractId: string): PublicWebEvidenceContext {
  const bundle = readJsonFile<PublicWebEvidenceBundle>(path);
  if (
    bundle?.schema_version !== PUBLIC_WEB_EVIDENCE_BUNDLE_SCHEMA ||
    bundle.contract_id !== contractId || !Array.isArray(bundle.items)
  ) return { items: [], attempts: [] };
  return {
    items: bundle.items.filter(isPublicWebEvidenceItem).slice(-MAX_CONTRACT_EVIDENCE_ITEMS),
    attempts: Array.isArray(bundle.attempts)
      ? bundle.attempts.filter(isPublicWebEvidenceAttempt).slice(-MAX_CONTRACT_EVIDENCE_ITEMS)
      : [],
  };
}

function evidenceAttempt(
  producer: PublicWebEvidenceAttempt["producer"],
  args: Record<string, unknown>,
  result: unknown,
  items: PublicWebEvidenceItem[],
): PublicWebEvidenceAttempt {
  const record = result && typeof result === "object" && !Array.isArray(result)
    ? result as Record<string, unknown>
    : {};
  const searchResults = Array.isArray(record.results) ? record.results.length : null;
  const observedAt = items[0]?.observed_at ?? new Date().toISOString();
  const outcome = items.length > 0
    ? "evidence" as const
    : producer === "web_search" && searchResults === 0
      ? "no_result" as const
      : "empty" as const;
  return {
    attempt_id: `public-web-attempt-${createHash("sha256")
      .update(`${producer}\n${stableJson(args)}\n${items.map((item) => item.evidence_item_id).sort().join(",")}\n${outcome}`)
      .digest("hex").slice(0, 24)}`,
    producer,
    outcome,
    observed_at: observedAt,
  };
}

function isPublicWebEvidenceAttempt(value: unknown): value is PublicWebEvidenceAttempt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.attempt_id === "string" &&
    (record.producer === "web_search" || record.producer === "web_read") &&
    new Set(["evidence", "no_result", "empty"]).has(String(record.outcome)) &&
    typeof record.observed_at === "string" && !Number.isNaN(Date.parse(record.observed_at));
}

function stableJson(value: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));
}

function bundlePath(butlerData: string, contractId: string): string {
  return join(butlerData, "public-web-evidence", "contracts", `${contractId}.json`);
}

function safeId(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,180}$/u.test(value)) throw new Error("public_web_evidence_contract_id_invalid");
  return value;
}
