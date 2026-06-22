import { expect, test } from "bun:test";
import {
  createEvidenceCapabilityReceipt,
  EVIDENCE_CAPABILITY_SCHEMA_VERSION,
  EVIDENCE_CAPABILITY_TAXONOMY,
  parseEvidenceCapabilityReceipt,
} from "../../packages/butler-agent/src/agent/output/evidence-capability-ledger.ts";

test("evidence capability taxonomy covers D01 proof families", () => {
  expect(EVIDENCE_CAPABILITY_TAXONOMY).toMatchObject({
    candidateDiscovery: "source_candidate",
    sourceVerification: "source_verified",
    execution: "command_executed",
    mutation: "workspace_mutated",
    artifact: "durable_artifact",
    validation: "validation_passed",
    browserObservation: "browser_observed",
    review: "review_completed",
    explicitBlocker: "explicit_blocker",
    limitation: "limitation_recorded",
  });
});

test("creates and parses a verified source capability receipt", () => {
  const receipt = createEvidenceCapabilityReceipt({
    producer: { kind: "tool", name: "web_read", call_id: "call-source" },
    capability: "source_verified",
    evidence_kind: "source_page",
    confidence: 0.92,
    summary: "A bounded public source page was read.",
    references: [{ label: "source", url: "https://example.com/report" }],
    satisfies: ["source_verified"],
    limitations: ["Only the bounded excerpt was retained."],
    created_at: "2026-06-22T08:00:00.000Z",
  });

  expect(receipt.schema_version).toBe(EVIDENCE_CAPABILITY_SCHEMA_VERSION);
  expect(receipt.verified).toBe(true);
  expect(receipt.maturity).toBe("verified");
  expect(receipt.satisfies).toEqual(["source_verified"]);

  const parsed = parseEvidenceCapabilityReceipt(receipt);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error("expected receipt to parse");
  expect(parsed.receipt).toMatchObject({
    producer: { kind: "tool", name: "web_read", call_id: "call-source" },
    capability: "source_verified",
    evidence_kind: "source_page",
    confidence: 0.92,
    limitations: ["Only the bounded excerpt was retained."],
  });
});

test("rejects malformed and unknown capability receipts", () => {
  const parsed = parseEvidenceCapabilityReceipt({
    receipt_id: "bad-receipt",
    schema_version: EVIDENCE_CAPABILITY_SCHEMA_VERSION,
    producer: { kind: "tool", name: "mystery_tool" },
    capability: "tool_name_looked_successful",
    evidence_kind: "source_page",
    maturity: "verified",
    confidence: 1.2,
    verified: true,
    summary: "A receipt tried to claim an unknown capability.",
    references: [],
    limitations: [],
    created_at: "2026-06-22T08:00:00.000Z",
  });

  expect(parsed.ok).toBe(false);
  expect(parsed.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
    "unknown_capability",
    "invalid_confidence",
  ]));
});

test("candidate discovery cannot satisfy completion obligations", () => {
  const parsed = parseEvidenceCapabilityReceipt({
    receipt_id: "candidate-receipt",
    schema_version: EVIDENCE_CAPABILITY_SCHEMA_VERSION,
    producer: { kind: "tool", name: "web_search" },
    capability: "source_candidate",
    evidence_kind: "source_candidate",
    maturity: "candidate",
    confidence: 0.6,
    verified: false,
    summary: "Search returned public source candidates.",
    references: [{ url: "https://example.com/candidate" }],
    satisfies: ["source_verified"],
    limitations: ["Candidate discovery is not page verification."],
    created_at: "2026-06-22T08:00:00.000Z",
  });

  expect(parsed.ok).toBe(false);
  expect(parsed.issues.map((issue) => issue.code)).toContain("satisfies_requires_verified");
});

test("verified candidate receipts still cannot satisfy source verification", () => {
  const parsed = parseEvidenceCapabilityReceipt({
    receipt_id: "verified-candidate-receipt",
    schema_version: EVIDENCE_CAPABILITY_SCHEMA_VERSION,
    producer: { kind: "tool", name: "web_search" },
    capability: "source_candidate",
    evidence_kind: "source_candidate",
    maturity: "verified",
    confidence: 0.9,
    verified: true,
    summary: "A malicious or malformed search candidate tried to satisfy source verification.",
    references: [{ url: "https://example.com/candidate" }],
    satisfies: ["source_verified"],
    limitations: [],
    created_at: "2026-06-22T08:00:00.000Z",
  });

  expect(parsed.ok).toBe(false);
  expect(parsed.issues.map((issue) => issue.code)).toContain("satisfies_not_supported_by_capability");
});

test("capability policy rejects unrelated obligation satisfaction", () => {
  const parsed = parseEvidenceCapabilityReceipt({
    receipt_id: "wrong-obligation-receipt",
    schema_version: EVIDENCE_CAPABILITY_SCHEMA_VERSION,
    producer: { kind: "tool", name: "run_command" },
    capability: "durable_artifact",
    evidence_kind: "artifact",
    maturity: "verified",
    confidence: 0.9,
    verified: true,
    summary: "An artifact receipt cannot prove command execution.",
    references: [{ artifact_id: "artifact-1" }],
    satisfies: ["command_executed"],
    limitations: [],
    created_at: "2026-06-22T08:00:00.000Z",
  });

  expect(parsed.ok).toBe(false);
  expect(parsed.issues.map((issue) => issue.code)).toContain("satisfies_not_supported_by_capability");
});

test("source and artifact obligations require structured references", () => {
  const sourceWithoutUrl = parseEvidenceCapabilityReceipt({
    receipt_id: "source-without-url",
    schema_version: EVIDENCE_CAPABILITY_SCHEMA_VERSION,
    producer: { kind: "tool", name: "web_read" },
    capability: "source_verified",
    evidence_kind: "source_page",
    maturity: "verified",
    confidence: 0.8,
    verified: true,
    summary: "Source claim lacks a URL reference.",
    references: [],
    satisfies: ["source_verified"],
    limitations: [],
    created_at: "2026-06-22T08:00:00.000Z",
  });
  const artifactWithoutRef = parseEvidenceCapabilityReceipt({
    receipt_id: "artifact-without-ref",
    schema_version: EVIDENCE_CAPABILITY_SCHEMA_VERSION,
    producer: { kind: "tool", name: "run_command" },
    capability: "durable_artifact",
    evidence_kind: "artifact",
    maturity: "verified",
    confidence: 0.8,
    verified: true,
    summary: "Artifact claim lacks structured artifact evidence.",
    references: [],
    satisfies: ["durable_artifact"],
    limitations: [],
    created_at: "2026-06-22T08:00:00.000Z",
  });

  expect(sourceWithoutUrl.ok).toBe(false);
  expect(artifactWithoutRef.ok).toBe(false);
  expect(sourceWithoutUrl.issues.map((issue) => issue.code)).toContain("satisfies_not_supported_by_capability");
  expect(artifactWithoutRef.issues.map((issue) => issue.code)).toContain("satisfies_not_supported_by_capability");
});

test("receipt references reject private absolute paths", () => {
  const parsed = parseEvidenceCapabilityReceipt({
    receipt_id: "private-path-receipt",
    schema_version: EVIDENCE_CAPABILITY_SCHEMA_VERSION,
    producer: { kind: "tool", name: "run_command" },
    capability: "durable_artifact",
    evidence_kind: "artifact",
    maturity: "verified",
    confidence: 0.8,
    verified: true,
    summary: "A command produced a file.",
    references: [{ label: "private output", path: "/private/butler/output.csv" }],
    satisfies: ["durable_artifact"],
    limitations: [],
    created_at: "2026-06-22T08:00:00.000Z",
  });

  expect(parsed.ok).toBe(false);
  expect(parsed.issues.map((issue) => issue.code)).toContain("unsafe_reference_path");
});

test("receipt references reject unsafe URLs and private labels", () => {
  const parsed = parseEvidenceCapabilityReceipt({
    receipt_id: "unsafe-reference-receipt",
    schema_version: EVIDENCE_CAPABILITY_SCHEMA_VERSION,
    producer: { kind: "tool", name: "web_read" },
    capability: "source_verified",
    evidence_kind: "source_page",
    maturity: "verified",
    confidence: 0.8,
    verified: true,
    summary: "Unsafe references should not parse.",
    references: [
      { label: "/private/butler/source", url: "file:///private/butler/source.html" },
    ],
    satisfies: ["source_verified"],
    limitations: [],
    created_at: "2026-06-22T08:00:00.000Z",
  });

  expect(parsed.ok).toBe(false);
  expect(parsed.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
    "unsafe_reference_text",
    "unsafe_reference_url",
  ]));
});

test("receipt references reject token-like labels", () => {
  const parsed = parseEvidenceCapabilityReceipt({
    receipt_id: "token-label-receipt",
    schema_version: EVIDENCE_CAPABILITY_SCHEMA_VERSION,
    producer: { kind: "tool", name: "web_read" },
    capability: "source_verified",
    evidence_kind: "source_page",
    maturity: "verified",
    confidence: 0.8,
    verified: true,
    summary: "Token-like labels should not parse.",
    references: [{ label: "Authorization: Bearer [redacted]", url: "https://example.com/source" }],
    satisfies: ["source_verified"],
    limitations: [],
    created_at: "2026-06-22T08:00:00.000Z",
  });

  expect(parsed.ok).toBe(false);
  expect(parsed.issues.map((issue) => issue.code)).toContain("unsafe_reference_text");
});
