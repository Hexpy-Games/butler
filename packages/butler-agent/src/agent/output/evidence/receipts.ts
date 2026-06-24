import type {
  EvidenceArtifactRef,
  EvidenceReceipt,
  EvidenceReference,
  PublicWorkObligationKind,
} from "../../turn/native/output/tool-types.ts";

const RECEIPT_SCHEMA = "butler.evidence-receipt.v1";

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => stringValue(item))
    .filter((item): item is string => Boolean(item));
}

function numericMetrics(value: unknown): Record<string, number> | undefined {
  const record = recordValue(value);
  if (!record) return undefined;
  const metrics = Object.fromEntries(Object.entries(record)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
  return Object.keys(metrics).length > 0 ? metrics : undefined;
}

function evidenceReference(value: unknown): EvidenceReference | null {
  const record = recordValue(value);
  if (!record) return null;
  const kind = stringValue(record.kind);
  const ref = stringValue(record.ref);
  if (
    !kind ||
    !ref ||
    ![
      "url",
      "artifact",
      "tool_output",
      "task",
      "worker",
      "project_document",
      "memory",
      "transcript_slice",
    ].includes(kind)
  ) {
    return null;
  }
  const label = stringValue(record.label);
  return {
    kind: kind as EvidenceReference["kind"],
    ref,
    ...(label ? { label } : {}),
  };
}

function evidenceArtifact(value: unknown): EvidenceArtifactRef | null {
  const record = recordValue(value);
  if (!record) return null;
  const id = stringValue(record.id);
  const label = stringValue(record.label);
  const path = stringValue(record.path);
  const mediaType = stringValue(record.mediaType ?? record.media_type);
  const role = stringValue(record.role);
  if (!id && !label && !path) return null;
  return {
    ...(id ? { id } : {}),
    ...(label ? { label } : {}),
    ...(path ? { path } : {}),
    ...(mediaType ? { mediaType } : {}),
    ...(role ? { role } : {}),
  };
}

function publicWorkObligation(value: string): PublicWorkObligationKind | null {
  if (
    value === "source_verified" ||
    value === "command_executed" ||
    value === "durable_artifact" ||
    value === "data_table_created" ||
    value === "chart_rendered"
  ) {
    return value;
  }
  return null;
}

function evidenceReceipt(value: unknown): EvidenceReceipt | null {
  const record = recordValue(value);
  if (!record || record.schema !== RECEIPT_SCHEMA) return null;
  const id = stringValue(record.id);
  const producer = recordValue(record.producer);
  const producerKind = stringValue(producer?.kind);
  const producerName = stringValue(producer?.name);
  const receiptType = stringValue(record.receiptType ?? record.receipt_type);
  const summary = stringValue(record.summary);
  if (
    !id ||
    !producerKind ||
    !producerName ||
    !receiptType ||
    !summary ||
    !["tool", "worker", "artifact", "memory", "project_ledger", "external_source"].includes(producerKind) ||
    !["source", "deliverable", "execution", "state", "coverage"].includes(receiptType)
  ) {
    return null;
  }
  const references = Array.isArray(record.references)
    ? record.references.map(evidenceReference).filter((item): item is EvidenceReference => Boolean(item))
    : [];
  const artifacts = Array.isArray(record.artifacts)
    ? record.artifacts.map(evidenceArtifact).filter((item): item is EvidenceArtifactRef => Boolean(item))
    : [];
  const satisfies = stringArray(record.satisfies)
    .map(publicWorkObligation)
    .filter((item): item is PublicWorkObligationKind => Boolean(item));
  return {
    schema: RECEIPT_SCHEMA,
    id,
    producer: {
      kind: producerKind as EvidenceReceipt["producer"]["kind"],
      name: producerName,
    },
    receiptType: receiptType as EvidenceReceipt["receiptType"],
    verified: record.verified === true,
    covers: stringArray(record.covers),
    summary,
    references,
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(satisfies.length > 0 ? { satisfies: [...new Set(satisfies)] } : {}),
    ...(numericMetrics(record.metrics) ? { metrics: numericMetrics(record.metrics) } : {}),
  };
}

export function evidenceReceiptsFromResult(result: unknown): EvidenceReceipt[] {
  const record = recordValue(result);
  if (!record || !Array.isArray(record.evidence_receipts)) return [];
  return record.evidence_receipts
    .map(evidenceReceipt)
    .filter((receipt): receipt is EvidenceReceipt => Boolean(receipt));
}

export function satisfiedCompletionObligationsFromEvidenceReceipts(
  receipts: EvidenceReceipt[],
): PublicWorkObligationKind[] {
  const satisfied = new Set<PublicWorkObligationKind>();
  for (const receipt of receipts) {
    if (!receipt.verified) continue;
    for (const obligation of receipt.satisfies ?? []) {
      satisfied.add(obligation);
    }
  }
  return [...satisfied];
}
