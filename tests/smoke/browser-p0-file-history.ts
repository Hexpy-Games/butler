import { strict as assert } from "node:assert";
import { closeSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";

/** Historical JSONL at the standing history; no sparse or truncated files. */
export function seedP0FileHistory(data: string) {
  const transcripts = join(data, "transcripts"), metrics = join(data, "metrics");
  mkdirSync(transcripts, { recursive: true }); mkdirSync(metrics, { recursive: true });
  const line = JSON.stringify({ kind: "tool_result", timestamp: "2026-01-01T00:00:00Z",
    payload: { name: "fixture", ok: true, text: "x".repeat(1000) } }) + "\n";
  const count = 8, largestBytes = 8_192;
  const otherBytes = Math.ceil((32_768 - largestBytes) / (count - 1));
  let transcriptBytes = 0, largestTranscriptBytes = 0;
  for (let i = 0; i < count; i++) {
    const bytes = writeHistorical(join(transcripts, `p0-history-${i}.jsonl`), line,
      i === 0 ? largestBytes : otherBytes);
    transcriptBytes += bytes; largestTranscriptBytes = Math.max(largestTranscriptBytes, bytes);
  }
  const metricLine = JSON.stringify({ ts: 1, scope: "btcc-guided:p0-history",
    turnId: "p0-history", promptTokens: 88, fixture: "x".repeat(1000) }) + "\n";
  const metricBytes = writeHistorical(join(metrics, "prompt-cache-usage.jsonl"), metricLine, 8_192);
  assert(transcriptBytes >= 32_768 && largestTranscriptBytes >= largestBytes);
  assert(metricBytes > 8_000);
  return { transcriptFiles: count, transcriptBytes, largestTranscriptBytes, metricBytes };
}

function writeHistorical(path: string, line: string, minimumBytes: number) {
  const unitBytes = Buffer.byteLength(line), records = Math.ceil(minimumBytes / unitBytes);
  const chunk = Buffer.from(line.repeat(256));
  const fd = openSync(path, "wx");
  try {
    for (let remaining = records; remaining > 0;) {
      const count = Math.min(remaining, 256), bytes = count * unitBytes;
      let written = 0;
      while (written < bytes) written += writeSync(fd, chunk, written, bytes - written);
      remaining -= count;
    }
  } finally { closeSync(fd); }
  const bytes = statSync(path).size;
  assert.equal(bytes, records * unitBytes, "Every complete JSONL record was written");
  return bytes;
}
