import { createHash, randomUUID } from "node:crypto";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
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
    covers: ["execution_result", "workspace_file"],
    summary: input.summary,
    references: input.references ? [input.references] : [],
    satisfies: input.satisfies ?? ["source_verified"],
  }];
}
