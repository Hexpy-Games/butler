import { closeSync, openSync, readSync, statSync } from "fs";

const DEFAULT_MAX_JSONL_LINE_BYTES = 4 * 1024 * 1024;

export interface OversizedJsonlRecord {
  bytes: number;
  complete: boolean;
}

export interface JsonlScanResult {
  bytesRead: number;
  trailingBytes: number;
  fileSize: number;
  device: number;
  inode: number;
  mtimeMs: number;
  oversizedLines: number;
  oversizedBytes: number;
}

/**
 * Stream one JSONL file into caller-owned projections. This module owns byte
 * framing and oversized-record policy; callers own parsing and reduction.
 */
export function scanJsonlFile(
  path: string,
  input: {
    startOffset?: number;
    maxLineBytes?: number;
    onLine: (line: string) => void;
    onTrailing?: (line: string) => void;
    onOversized?: (record: OversizedJsonlRecord) => void;
  },
): JsonlScanResult {
  const stat = statSync(path);
  const startOffset = Math.max(0, Math.min(stat.size, Math.trunc(input.startOffset ?? 0)));
  const fd = openSync(path, "r");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  const maxLineBytes = Math.max(
    1,
    Math.trunc(input.maxLineBytes ?? DEFAULT_MAX_JSONL_LINE_BYTES),
  );
  let position = startOffset;
  let trailingBytes = 0;
  let lineBytes = 0;
  let lineParts: Buffer[] = [];
  let oversized = false;
  let oversizedLines = 0;
  let oversizedBytes = 0;

  const appendLineBytes = (bytes: Uint8Array): void => {
    lineBytes += bytes.byteLength;
    if (oversized) return;
    if (lineBytes > maxLineBytes) {
      oversized = true;
      lineParts = [];
      return;
    }
    if (bytes.byteLength > 0) lineParts.push(Buffer.from(bytes));
  };

  const finishLine = (complete: boolean): void => {
    if (lineBytes === 0 && complete) {
      lineParts = [];
      oversized = false;
      return;
    }
    if (oversized) {
      oversizedLines += 1;
      oversizedBytes += lineBytes;
      input.onOversized?.({ bytes: lineBytes, complete });
    } else if (complete) {
      input.onLine(Buffer.concat(lineParts).toString("utf8").replace(/\r$/u, ""));
    } else if (lineBytes > 0) {
      input.onTrailing?.(Buffer.concat(lineParts).toString("utf8"));
    }
    lineBytes = 0;
    lineParts = [];
    oversized = false;
  };

  try {
    while (position < stat.size) {
      const bytesToRead = Math.min(chunk.byteLength, stat.size - position);
      const bytesRead = readSync(fd, chunk, 0, bytesToRead, position);
      if (bytesRead <= 0) break;
      position += bytesRead;
      let segmentStart = 0;
      while (segmentStart < bytesRead) {
        let newline = -1;
        for (let index = segmentStart; index < bytesRead; index += 1) {
          if (chunk[index] === 0x0a) {
            newline = index;
            break;
          }
        }
        if (newline < 0) {
          appendLineBytes(chunk.subarray(segmentStart, bytesRead));
          break;
        }
        appendLineBytes(chunk.subarray(segmentStart, newline));
        finishLine(true);
        segmentStart = newline + 1;
      }
      trailingBytes = lineBytes;
    }
    finishLine(false);
  } finally {
    closeSync(fd);
  }
  return {
    bytesRead: Math.max(0, position - startOffset),
    trailingBytes,
    fileSize: stat.size,
    device: Number(stat.dev),
    inode: Number(stat.ino),
    mtimeMs: Number(stat.mtimeMs),
    oversizedLines,
    oversizedBytes,
  };
}
