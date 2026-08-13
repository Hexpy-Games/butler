import { createHash } from "node:crypto";

export const OPERATION_OUTPUT_CHUNK_EVENT_KIND = "operation.output.chunk";
export const OPERATION_OUTPUT_CHUNK_BYTES = 32 * 1024;

export type OperationOutputChunkPayload = {
  requestId: string;
  resultId: string;
  resultSha256: string;
  chunkIndex: number;
  chunkCount: number;
  byteStart: number;
  byteEnd: number;
  byteLength: number;
  contentBase64: string;
  contentSha256: string;
};

export function operationOutputChunkPayloads(input: {
  requestId: string;
  resultId: string;
  resultSha256: string;
  resultJson: string;
}): OperationOutputChunkPayload[] {
  const bytes = Buffer.from(input.resultJson, "utf8");
  if (sha256(bytes) !== input.resultSha256) {
    throw new Error("operation output result digest mismatch");
  }
  if (
    sha256(Buffer.from(`btcc-guided-tool-result.v1\0${input.resultSha256}`, "utf8")) !==
      input.resultId
  ) {
    throw new Error("operation output result identity mismatch");
  }
  const chunkCount = Math.max(1, Math.ceil(bytes.byteLength / OPERATION_OUTPUT_CHUNK_BYTES));
  return Array.from({ length: chunkCount }, (_unused, chunkIndex) => {
    const byteStart = chunkIndex * OPERATION_OUTPUT_CHUNK_BYTES;
    const byteEnd = Math.min(bytes.byteLength, byteStart + OPERATION_OUTPUT_CHUNK_BYTES);
    const content = bytes.subarray(byteStart, byteEnd);
    return {
      requestId: requiredToken(input.requestId, "operation output requestId"),
      resultId: requiredToken(input.resultId, "operation output resultId"),
      resultSha256: requiredDigest(input.resultSha256, "operation output resultSha256"),
      chunkIndex,
      chunkCount,
      byteStart,
      byteEnd,
      byteLength: bytes.byteLength,
      contentBase64: content.toString("base64"),
      contentSha256: sha256(content),
    };
  });
}

export function normalizeOperationOutputChunkPayload(
  payload: Record<string, unknown>,
): OperationOutputChunkPayload {
  const normalized = {
    requestId: requiredToken(payload.requestId, "operation output requestId"),
    resultId: requiredToken(payload.resultId, "operation output resultId"),
    resultSha256: requiredDigest(payload.resultSha256, "operation output resultSha256"),
    chunkIndex: requiredInteger(payload.chunkIndex, "operation output chunkIndex"),
    chunkCount: requiredPositiveInteger(payload.chunkCount, "operation output chunkCount"),
    byteStart: requiredInteger(payload.byteStart, "operation output byteStart"),
    byteEnd: requiredInteger(payload.byteEnd, "operation output byteEnd"),
    byteLength: requiredInteger(payload.byteLength, "operation output byteLength"),
    contentBase64: requiredBase64(payload.contentBase64),
    contentSha256: requiredDigest(payload.contentSha256, "operation output contentSha256"),
  };
  if (normalized.chunkIndex >= normalized.chunkCount) {
    throw new Error("operation output chunkIndex must be below chunkCount");
  }
  if (normalized.byteStart > normalized.byteEnd || normalized.byteEnd > normalized.byteLength) {
    throw new Error("operation output byte range is invalid");
  }
  const content = Buffer.from(normalized.contentBase64, "base64");
  if (content.byteLength !== normalized.byteEnd - normalized.byteStart) {
    throw new Error("operation output chunk byte length mismatch");
  }
  if (sha256(content) !== normalized.contentSha256) {
    throw new Error("operation output chunk digest mismatch");
  }
  return normalized;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function requiredToken(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requiredDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requiredInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  const integer = requiredInteger(value, label);
  if (integer < 1) throw new Error(`${label} is invalid`);
  return integer;
}

function requiredBase64(value: unknown): string {
  if (typeof value !== "string" || value.length > OPERATION_OUTPUT_CHUNK_BYTES * 2) {
    throw new Error("operation output contentBase64 is invalid");
  }
  if (value && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error("operation output contentBase64 is invalid");
  }
  return value;
}
