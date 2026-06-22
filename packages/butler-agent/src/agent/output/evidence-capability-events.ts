import { sanitizePublicText } from "../events/turn-events.ts";
import { createEvidenceCapabilityReceipt } from "./evidence-capability-parser.ts";
import type {
  EvidenceCapabilityMaturity,
  EvidenceCapabilityProducerKind,
  EvidenceCapabilityReceipt,
  EvidenceCapabilityReference,
} from "./evidence-capability-types.ts";

type EventProducer = {
  kind?: EvidenceCapabilityProducerKind;
  name: string;
  call_id?: string;
};

export type EvidenceEventResult = "passed" | "failed" | "partial" | "skipped";
export type BrowserObservationResult = "observed" | "failed" | "partial" | "skipped";
export type ReviewEvidenceResult = "completed" | "changes_requested" | "blocked" | "partial" | "skipped";

export function commandExecutionCapabilityReceipt(input: {
  producer: EventProducer;
  success: boolean;
  exitCode: number | null;
  timedOut: boolean;
  skipped?: boolean;
}): EvidenceCapabilityReceipt {
  const status = input.skipped ? "skipped" : input.timedOut ? "timed_out" : input.success ? "succeeded" : "failed";
  return createEvidenceCapabilityReceipt({
    producer: producer(input.producer),
    capability: "command_executed",
    evidence_kind: "execution_result",
    maturity: input.success ? "verified" : input.timedOut ? "candidate" : "rejected",
    verified: input.success,
    confidence: input.success ? 1 : input.timedOut ? 0.45 : 0.35,
    summary: input.success
      ? "A local command executed successfully."
      : "A local command executed but did not complete successfully.",
    scope: {
      status,
      exit_code: input.exitCode,
      timed_out: input.timedOut,
    },
    satisfies: input.success ? ["command_executed"] : [],
    limitations: input.success ? [] : [commandFailureSummary(input)],
  });
}

export function validationCapabilityReceipt(input: {
  producer: EventProducer;
  suite: string;
  result: EvidenceEventResult;
  failureSummary?: string;
  references?: EvidenceCapabilityReference[];
  limitations?: string[];
}): EvidenceCapabilityReceipt {
  const passed = input.result === "passed";
  return createEvidenceCapabilityReceipt({
    producer: producer(input.producer),
    capability: "validation_passed",
    evidence_kind: "execution_result",
    maturity: maturityForResult(input.result),
    verified: passed,
    confidence: passed ? 0.95 : input.result === "partial" ? 0.55 : 0.25,
    summary: passed
      ? "A validation suite completed successfully."
      : "A validation suite did not complete successfully.",
    scope: {
      suite: safeScopeText(input.suite, "validation"),
      result: input.result,
      ...(input.failureSummary ? { failure_summary: safeScopeText(input.failureSummary, "Validation did not pass.") } : {}),
    },
    references: input.references ?? [],
    limitations: [
      ...(input.failureSummary ? [safeScopeText(input.failureSummary, "Validation did not pass.")] : []),
      ...(input.limitations ?? []),
    ],
  });
}

export function browserObservationCapabilityReceipt(input: {
  producer: EventProducer;
  result: BrowserObservationResult;
  observation: string;
  references?: EvidenceCapabilityReference[];
  limitations?: string[];
}): EvidenceCapabilityReceipt {
  const verified = input.result === "observed";
  return createEvidenceCapabilityReceipt({
    producer: producer(input.producer),
    capability: "browser_observed",
    evidence_kind: "browser_observation",
    maturity: maturityForObservation(input.result),
    verified,
    confidence: verified ? 0.9 : input.result === "partial" ? 0.55 : 0.2,
    summary: verified
      ? "A browser observation was recorded."
      : "A browser observation was attempted but did not fully complete.",
    scope: {
      result: input.result,
      observation: safeScopeText(input.observation, "Browser observation"),
    },
    references: input.references ?? [],
    limitations: input.limitations ?? [],
  });
}

export function reviewCapabilityReceipt(input: {
  producer: EventProducer;
  result: ReviewEvidenceResult;
  outcome: string;
  references?: EvidenceCapabilityReference[];
  limitations?: string[];
}): EvidenceCapabilityReceipt {
  const verified = input.result === "completed";
  return createEvidenceCapabilityReceipt({
    producer: producer(input.producer),
    capability: "review_completed",
    evidence_kind: "review_result",
    maturity: maturityForReview(input.result),
    verified,
    confidence: verified ? 0.9 : input.result === "partial" ? 0.55 : 0.25,
    summary: verified
      ? "An implementation review was completed."
      : "An implementation review produced a non-complete outcome.",
    scope: {
      result: input.result,
      outcome: safeScopeText(input.outcome, "Review outcome"),
    },
    references: input.references ?? [],
    limitations: input.limitations ?? [],
  });
}

function producer(input: EventProducer): EvidenceCapabilityReceipt["producer"] {
  return {
    kind: input.kind ?? "tool",
    name: input.name,
    ...(input.call_id ? { call_id: input.call_id } : {}),
  };
}

function maturityForResult(result: EvidenceEventResult): EvidenceCapabilityMaturity {
  if (result === "passed") return "verified";
  if (result === "partial") return "candidate";
  return "rejected";
}

function maturityForObservation(result: BrowserObservationResult): EvidenceCapabilityMaturity {
  if (result === "observed") return "verified";
  if (result === "partial") return "candidate";
  return "rejected";
}

function maturityForReview(result: ReviewEvidenceResult): EvidenceCapabilityMaturity {
  if (result === "completed") return "verified";
  if (result === "partial" || result === "changes_requested") return "candidate";
  return "rejected";
}

function commandFailureSummary(input: {
  exitCode: number | null;
  timedOut: boolean;
  skipped?: boolean;
}): string {
  if (input.skipped) return "Command execution was skipped before dispatch.";
  if (input.timedOut) return "Command timed out before completion.";
  return `Command exited with status ${input.exitCode ?? "unknown"}.`;
}

function safeScopeText(value: string, fallback: string): string {
  return sanitizePublicText(value, fallback).replace(/\s+/gu, " ").trim().slice(0, 180) || fallback;
}
