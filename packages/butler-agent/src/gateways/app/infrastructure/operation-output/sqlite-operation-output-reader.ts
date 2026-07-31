import type { Database } from "bun:sqlite";
import { digest } from
  "../../../../agent/btcc/identity.ts";
import type { OperationOutputView } from
  "../../interface/protocol/app-protocol.ts";

const OUTPUT_PAGE_BYTES = 64 * 1024;

type GuidedToolResult = {
  turn_id: string;
  call_id: string;
  result_json: string;
  result_sha256: string;
};

export class SqliteOperationOutputReader {
  constructor(private readonly db: Database) {}

  read(input: {
    turnId: string;
    requestId: string;
    resultId: string;
    byteStart: number;
    allowAliasedRequest?: boolean;
  }): OperationOutputView | null {
    const exact = this.db.query<GuidedToolResult, [string, string]>(`
      SELECT turn_id, call_id, result_json, result_sha256
      FROM btcc_guided_tool_calls
      WHERE turn_id = ? AND call_id = ? AND result_json IS NOT NULL
        AND result_sha256 IS NOT NULL
    `).get(input.turnId, input.requestId);
    const stored = exact && resultId(exact.result_sha256) === input.resultId
      ? exact
      : input.allowAliasedRequest === true
        ? this.findAliased(input.turnId, input.resultId)
        : null;
    if (!stored || digest(stored.result_json) !== stored.result_sha256) return null;

    const payload = Buffer.from(stored.result_json, "utf8");
    const byteStart = Math.max(0, Math.min(input.byteStart, payload.byteLength));
    const bytes = payload.subarray(
      byteStart,
      Math.min(payload.byteLength, byteStart + OUTPUT_PAGE_BYTES),
    );
    const contentBytes = completeUtf8Prefix(bytes);
    const byteEnd = byteStart + contentBytes.byteLength;
    return {
      turn_id: input.turnId,
      request_id: input.requestId,
      result_id: input.resultId,
      content: contentBytes.toString("utf8"),
      byte_start: byteStart,
      byte_end: byteEnd,
      byte_length: payload.byteLength,
      complete: byteEnd >= payload.byteLength,
    };
  }

  private findAliased(turnId: string, expectedResultId: string): GuidedToolResult | null {
    return this.db.query<GuidedToolResult, [string]>(`
      SELECT turn_id, call_id, result_json, result_sha256
      FROM btcc_guided_tool_calls
      WHERE turn_id = ? AND result_json IS NOT NULL AND result_sha256 IS NOT NULL
      ORDER BY started_at, call_id
    `).all(turnId).find((row) => resultId(row.result_sha256) === expectedResultId)
      ?? null;
  }
}

function resultId(resultSha256: string): string {
  return digest(`btcc-guided-tool-result.v1\0${resultSha256}`);
}

function completeUtf8Prefix(bytes: Buffer): Buffer {
  if (bytes.byteLength === 0) return bytes;
  let leadIndex = bytes.byteLength - 1;
  while (leadIndex > 0 && isContinuationByte(bytes[leadIndex]!)) leadIndex -= 1;
  const expected = utf8SequenceLength(bytes[leadIndex]!);
  const available = bytes.byteLength - leadIndex;
  return expected > available ? bytes.subarray(0, leadIndex) : bytes;
}

function isContinuationByte(value: number): boolean {
  return (value & 0xc0) === 0x80;
}

function utf8SequenceLength(value: number): number {
  if ((value & 0x80) === 0) return 1;
  if ((value & 0xe0) === 0xc0) return 2;
  if ((value & 0xf0) === 0xe0) return 3;
  if ((value & 0xf8) === 0xf0) return 4;
  return 1;
}
