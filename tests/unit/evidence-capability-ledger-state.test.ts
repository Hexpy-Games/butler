import { expect, test } from "bun:test";
import {
  buildEvidenceCapabilityLedger,
  createEvidenceCapabilityReceipt,
  EVIDENCE_CAPABILITY_SCHEMA_VERSION,
  missingCompletionObligationsFromLedger,
} from "../../packages/butler-agent/src/agent/output/evidence-capability-ledger.ts";

test("ledger keeps malformed receipts as rejected evidence", () => {
  const ledger = buildEvidenceCapabilityLedger({
    required: ["source_verified"],
    receipts: [{
      receipt_id: "bad-receipt",
      schema_version: EVIDENCE_CAPABILITY_SCHEMA_VERSION,
      producer: { kind: "tool", name: "web_read" },
      capability: "unknown_capability",
      evidence_kind: "source_page",
      maturity: "verified",
      confidence: 0.9,
      verified: true,
      summary: "Malformed capability should stay inspectable.",
      references: [],
      limitations: [],
      created_at: "2026-06-22T08:00:00.000Z",
    }],
  });

  expect(ledger.receipts).toEqual([]);
  expect(ledger.rejectedReceipts).toHaveLength(1);
  expect(ledger.rejectedReceipts[0].receipt_id).toBe("bad-receipt");
  expect(ledger.rejectedReceipts[0].issues.map((issue) => issue.code)).toContain("unknown_capability");
  expect(missingCompletionObligationsFromLedger(ledger)).toEqual(["source_verified"]);
});

test("ledger distinguishes search candidates from verified source evidence", () => {
  const searchCandidate = createEvidenceCapabilityReceipt({
    producer: { kind: "tool", name: "web_search" },
    capability: "source_candidate",
    evidence_kind: "source_candidate",
    maturity: "candidate",
    verified: false,
    confidence: 0.5,
    summary: "Search returned source candidates.",
    references: [{ url: "https://example.com/candidate" }],
    limitations: ["Search result only; source page was not read."],
    created_at: "2026-06-22T08:00:00.000Z",
  });
  const verifiedSource = createEvidenceCapabilityReceipt({
    producer: { kind: "tool", name: "web_read" },
    capability: "source_verified",
    evidence_kind: "source_page",
    summary: "Source page was read.",
    references: [{ url: "https://example.com/candidate" }],
    satisfies: ["source_verified"],
    created_at: "2026-06-22T08:01:00.000Z",
  });

  const candidateLedger = buildEvidenceCapabilityLedger({
    required: ["source_verified"],
    receipts: [searchCandidate],
  });
  expect(candidateLedger.satisfied).toEqual([]);
  expect(candidateLedger.missing).toEqual(["source_verified"]);

  const verifiedLedger = buildEvidenceCapabilityLedger({
    required: ["source_verified"],
    receipts: [searchCandidate, verifiedSource],
  });
  expect(verifiedLedger.satisfied).toEqual(["source_verified"]);
  expect(verifiedLedger.missing).toEqual([]);
});

test("ledger normalizes legacy web search and web read receipts by capability", () => {
  const legacySearch = {
    schema: "butler.evidence-receipt.v1",
    id: "legacy-search",
    producer: { kind: "tool", name: "web_search" },
    receiptType: "coverage",
    verified: true,
    covers: ["source_candidates"],
    summary: "Search returned public source candidates.",
    references: [{ kind: "url", ref: "https://example.com/candidate" }],
  };
  const legacyRead = {
    schema: "butler.evidence-receipt.v1",
    id: "legacy-read",
    producer: { kind: "tool", name: "web_read" },
    receiptType: "source",
    verified: true,
    covers: ["source_verified"],
    summary: "A public source page was read.",
    references: [{ kind: "url", ref: "https://example.com/candidate" }],
    satisfies: ["source_verified"],
  };

  const candidateOnly = buildEvidenceCapabilityLedger({
    required: ["source_verified"],
    receipts: [legacySearch],
  });
  expect(candidateOnly.receipts).toHaveLength(1);
  expect(candidateOnly.receipts[0]).toMatchObject({
    capability: "source_candidate",
    maturity: "candidate",
    verified: false,
  });
  expect(candidateOnly.satisfied).toEqual([]);
  expect(candidateOnly.missing).toEqual(["source_verified"]);

  const withRead = buildEvidenceCapabilityLedger({
    required: ["source_verified"],
    receipts: [legacySearch, legacyRead],
  });
  expect(withRead.rejectedReceipts).toEqual([]);
  expect(withRead.satisfied).toEqual(["source_verified"]);
  expect(withRead.missing).toEqual([]);
});

test("legacy search and artifact receipts cannot fake missing structure", () => {
  const legacySearchWithSatisfies = {
    schema: "butler.evidence-receipt.v1",
    id: "legacy-search-fake",
    producer: { kind: "tool", name: "web_search" },
    receiptType: "coverage",
    verified: true,
    covers: ["source_candidates"],
    summary: "Search tried to satisfy source verification.",
    references: [{ kind: "url", ref: "https://example.com/candidate" }],
    satisfies: ["source_verified"],
  };
  const legacyArtifactWithoutArtifact = {
    schema: "butler.evidence-receipt.v1",
    id: "legacy-artifact-fake",
    producer: { kind: "tool", name: "run_command" },
    receiptType: "deliverable",
    verified: true,
    covers: ["durable_deliverable"],
    summary: "Artifact claim lacks artifact evidence.",
    references: [],
    satisfies: ["durable_artifact"],
  };

  const ledger = buildEvidenceCapabilityLedger({
    required: ["source_verified", "durable_artifact"],
    receipts: [legacySearchWithSatisfies, legacyArtifactWithoutArtifact],
  });

  expect(ledger.satisfied).toEqual([]);
  expect(ledger.missing).toEqual(["source_verified", "durable_artifact"]);
  expect(ledger.rejectedReceipts.map((receipt) => receipt.receipt_id)).toEqual(expect.arrayContaining([
    "legacy-search-fake",
    "legacy-artifact-fake",
  ]));
});
