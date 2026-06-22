import { extname } from "path";
import {
  createEvidenceCapabilityReceipt,
  validationCapabilityReceipt,
} from "../../../output/evidence-capability-ledger.ts";
import { evidenceReceipt } from "../../../tool-support/executor-support.ts";
import type { EvidenceReceipt, PublicWorkObligationKind } from "../../../turn/native-tool-types.ts";
import type { EvidenceCapabilityReceipt } from "../../../output/evidence-capability-ledger.ts";

type CommandExecutionStatus = "succeeded" | "failed" | "timed_out";
type CommandArtifactKind = "csv_file" | "table_file" | "chart_file" | "file";

export interface CommandArtifactEvidence {
  path: string;
  artifact_kind: CommandArtifactKind;
  size_bytes: number;
  modified_at: string;
}

export interface CommandValidationEvidence {
  suite: string;
  result: "passed" | "failed" | "partial" | "skipped";
  failure_summary?: string;
}

export function commandEvidenceReceipts(input: {
  success: boolean;
  artifacts: CommandArtifactEvidence[];
}): EvidenceReceipt[] {
  const receipts: EvidenceReceipt[] = [
    evidenceReceipt({
      producerName: "run_command",
      receiptType: "execution",
      summary: input.success
        ? "A local command executed successfully."
        : "A local command was executed but did not complete successfully.",
      covers: ["execution_result"],
      verified: input.success,
      satisfies: input.success ? ["command_executed"] : [],
    }),
  ];
  if (input.artifacts.length > 0) {
    const satisfies = new Set<PublicWorkObligationKind>(["durable_artifact"]);
    if (input.artifacts.some((artifact) =>
      artifact.artifact_kind === "csv_file" || artifact.artifact_kind === "table_file",
    )) {
      satisfies.add("data_table_created");
    }
    if (input.artifacts.some((artifact) => artifact.artifact_kind === "chart_file")) {
      satisfies.add("chart_rendered");
    }
    receipts.push(evidenceReceipt({
      producerName: "run_command",
      receiptType: "deliverable",
      summary: "The command produced verified durable output file evidence.",
      covers: ["durable_deliverable"],
      artifacts: input.artifacts.map((artifact) => ({
        label: artifact.path,
        path: artifact.path,
        mediaType: commandArtifactMediaType(artifact),
        role: commandArtifactRole(artifact),
      })),
      satisfies: [...satisfies],
      metrics: {
        artifact_count: input.artifacts.length,
      },
    }));
  }
  return receipts;
}

function commandExecutionStatus(input: {
  exitCode: number | null;
  timedOut: boolean;
}): CommandExecutionStatus {
  if (input.timedOut) return "timed_out";
  return input.exitCode === 0 ? "succeeded" : "failed";
}

function exitCodeLabel(exitCode: number | null): string {
  return exitCode === null ? "none" : String(exitCode);
}

function safeArtifactPath(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed || trimmed.startsWith("/") || trimmed.startsWith("~")) return null;
  if (/^[A-Za-z]:[\\/]/u.test(trimmed)) return null;
  if (trimmed.split(/[\\/]+/u).includes("..")) return null;
  return trimmed;
}

export function commandEvidenceCapabilityReceipts(input: {
  exitCode: number | null;
  timedOut: boolean;
  outputSuppressed: boolean;
  outputBudgeted: boolean;
  artifacts?: CommandArtifactEvidence[];
  validations?: CommandValidationEvidence[];
}): EvidenceCapabilityReceipt[] {
  const status = commandExecutionStatus(input);
  const verified = status === "succeeded";
  const receipts: EvidenceCapabilityReceipt[] = [
    createEvidenceCapabilityReceipt({
      producer: { kind: "tool", name: "run_command" },
      capability: "command_executed",
      evidence_kind: "execution_result",
      maturity: verified ? "verified" : status === "timed_out" ? "candidate" : "rejected",
      verified,
      confidence: verified ? 1 : status === "timed_out" ? 0.45 : 0.65,
      summary: `Command execution ${status} with exit code ${exitCodeLabel(input.exitCode)}.`,
      scope: {
        status,
        exit_code: input.exitCode,
        timed_out: input.timedOut,
        output_suppressed: input.outputSuppressed,
        output_budgeted: input.outputBudgeted,
      },
      ...(verified ? { satisfies: ["command_executed" as const] } : {}),
      limitations: verified ? [] : ["Command execution did not complete successfully."],
    }),
  ];

  for (const validation of input.validations ?? []) {
    receipts.push(validationCapabilityReceipt({
      producer: { kind: "tool", name: "run_command" },
      suite: validation.suite,
      result: validation.result,
      failureSummary: validation.failure_summary,
    }));
  }

  for (const artifact of input.artifacts ?? []) {
    receipts.push(...artifactCapabilityReceipts(artifact));
  }
  return receipts;
}

function artifactCapabilityReceipts(artifact: CommandArtifactEvidence): EvidenceCapabilityReceipt[] {
  const path = safeArtifactPath(artifact.path);
  if (!path) return [];
  const reference = { label: path, path };
  const scope = {
    artifact_kind: artifact.artifact_kind,
    size_bytes: artifact.size_bytes,
    modified_at: artifact.modified_at,
  };
  const receipts = [
    createEvidenceCapabilityReceipt({
      producer: { kind: "tool", name: "run_command" },
      capability: "durable_artifact",
      evidence_kind: "artifact",
      maturity: "verified",
      verified: true,
      confidence: 0.9,
      summary: "Command produced a verified durable artifact reference.",
      scope,
      references: [reference],
      satisfies: ["durable_artifact"],
    }),
  ];
  if (artifact.artifact_kind === "csv_file" || artifact.artifact_kind === "table_file") {
    receipts.push(createEvidenceCapabilityReceipt({
      producer: { kind: "tool", name: "run_command" },
      capability: "data_table_created",
      evidence_kind: "data_table",
      maturity: "verified",
      verified: true,
      confidence: 0.9,
      summary: "Command produced a verified structured table artifact.",
      scope,
      references: [reference],
      satisfies: ["data_table_created"],
    }));
  }
  if (artifact.artifact_kind === "chart_file") {
    receipts.push(createEvidenceCapabilityReceipt({
      producer: { kind: "tool", name: "run_command" },
      capability: "chart_rendered",
      evidence_kind: "chart",
      maturity: "verified",
      verified: true,
      confidence: 0.9,
      summary: "Command produced a verified chart artifact.",
      scope,
      references: [reference],
      satisfies: ["chart_rendered"],
    }));
  }
  return receipts;
}

function commandArtifactMediaType(artifact: CommandArtifactEvidence): string {
  const ext = extname(artifact.path).toLocaleLowerCase("en-US");
  if (artifact.artifact_kind === "csv_file") return "text/csv";
  if (artifact.artifact_kind === "table_file") return "text/tab-separated-values";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".pdf") return "application/pdf";
  return "application/octet-stream";
}

function commandArtifactRole(artifact: CommandArtifactEvidence): string {
  if (artifact.artifact_kind === "csv_file" || artifact.artifact_kind === "table_file") return "table";
  if (artifact.artifact_kind === "chart_file") return "chart";
  return "file";
}
