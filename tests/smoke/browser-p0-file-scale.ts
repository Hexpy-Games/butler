import { strict as assert } from "node:assert";
import { closeSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";

/** Historical JSONL at the standing owner scale; no sparse or truncated files. */
export function seedP0FileScale(data: string) {
  const transcripts = join(data, "transcripts"), metrics = join(data, "metrics");
  mkdirSync(transcripts, { recursive: true }); mkdirSync(metrics, { recursive: true });
  const line = JSON.stringify({ kind: "tool_result", timestamp: "2026-01-01T00:00:00Z",
    payload: { name: "fixture", ok: true, text: "x".repeat(1000) } }) + "\n";
  const count = 2440, largestBytes = 290_000_000;
  const otherBytes = Math.ceil((1_500_000_000 - largestBytes) / (count - 1));
  let transcriptBytes = 0, largestTranscriptBytes = 0;
  for (let i = 0; i < count; i++) {
    const bytes = writeHistorical(join(transcripts, `p0-history-${i}.jsonl`), line,
      i === 0 ? largestBytes : otherBytes);
    transcriptBytes += bytes; largestTranscriptBytes = Math.max(largestTranscriptBytes, bytes);
  }
  const metricLine = JSON.stringify({ ts: 1, scope: "btcc-guided:p0-history",
    turnId: "p0-history", promptTokens: 88, fixture: "x".repeat(1000) }) + "\n";
  const metricBytes = writeHistorical(join(metrics, "prompt-cache-usage.jsonl"), metricLine, 320 * 1024 ** 2);
  assert(transcriptBytes >= 1_500_000_000 && largestTranscriptBytes >= largestBytes);
  assert(metricBytes > 300 * 1024 ** 2);
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
