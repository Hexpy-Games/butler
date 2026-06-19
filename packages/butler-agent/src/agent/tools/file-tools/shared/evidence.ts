import { createHash, randomUUID } from "node:crypto";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function operationCover(toolName: string): string {
  if (toolName === "read_file") return "workspace_file_read";
  if (toolName === "write_file") return "workspace_file_written";
  if (toolName === "grep_files") return "workspace_search_result";
  return "workspace_file_operation";
}

export function fileToolEvidenceReceipt(input: {
  toolName: string;
  summary: string;
  references?: Record<string, unknown>;
  satisfies?: string[];
}) {
  return [{
    schema: "butler.evidence-receipt.v1",
    id: `receipt-${input.toolName}-${randomUUID()}`,
    producer: { kind: "tool", name: input.toolName },
    receiptType: "execution",
    verified: true,
    covers: ["execution_result", operationCover(input.toolName)],
    summary: input.summary,
    references: input.references ? [input.references] : [],
    satisfies: input.satisfies ?? ["source_verified"],
  }];
}
