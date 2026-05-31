import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  appendTranscriptEvent,
  createTranscriptEvent,
} from "../../packages/butler-agent/src/test-support/harness/transcripts.ts";
import {
  compactTranscript,
  compactionMetricsPath,
  compactionPath,
  maybeAutoCompactSession,
  readCompactionMetrics,
  readLatestCompactionSnapshot,
  renderCompactionContext,
  writeFailedCompactionDiagnostic,
} from "../../packages/butler-agent/src/agent/context/compaction.ts";

let tempDir = "";
let originalButlerData: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "butler-context-compaction-"));
  originalButlerData = process.env.BUTLER_DATA;
  process.env.BUTLER_DATA = tempDir;
});

afterEach(() => {
  if (originalButlerData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = originalButlerData;
  rmSync(tempDir, { recursive: true, force: true });
});

function appendConversation(count: number): void {
  for (let index = 0; index < count; index += 1) {
    appendTranscriptEvent(createTranscriptEvent({
      sessionId: "butler/main",
      eventId: `u-${index}`,
      kind: "inbound",
      timestamp: new Date(index * 1_000).toISOString(),
      payload: {
        message: {
          text: `사용자 목표 ${index}: 프로젝트 결정을 기억하고 worker 상태를 유지해야 합니다. ${"맥락 ".repeat(30)}`,
        },
      },
    }));
    appendTranscriptEvent(createTranscriptEvent({
      sessionId: "butler/main",
      eventId: `a-${index}`,
      kind: "outbound",
      timestamp: new Date(index * 1_000 + 1).toISOString(),
      payload: {
        message: {
          text: `결정 ${index}: 이 선택은 나중에 회상되어야 합니다. ${"세부사항 ".repeat(30)}`,
        },
      },
    }));
  }
}

test("compaction writes provenance snapshots and preserves suffix ids", async () => {
  appendConversation(10);

  const snapshot = await compactTranscript({
    butlerData: tempDir,
    sessionId: "butler/main",
    trigger: "manual",
    modelRef: "openai/test",
    preserveLastEvents: 4,
    budgetOverrides: {
      contextWindowTokens: 1_000,
      reservedOutputTokens: 20,
      reservedToolTokens: 20,
    },
  });

  expect(snapshot.status).toBe("ok");
  expect(snapshot.summary).toContain("Events summarized");
  expect(snapshot.summarized_event_range.event_count).toBeGreaterThan(0);
  expect(snapshot.preserved_suffix_event_ids).toHaveLength(4);
  expect(snapshot.provenance.length).toBeGreaterThan(0);
  expect(snapshot.post_estimated_tokens).toBeLessThan(snapshot.pre_estimated_tokens);
  expect(existsSync(compactionPath(tempDir, "butler/main"))).toBe(true);

  const rendered = renderCompactionContext(readLatestCompactionSnapshot({
    butlerData: tempDir,
    sessionId: "butler/main",
  }));
  expect(rendered).toContain("## Compaction Summary");
  expect(rendered).toContain("source of truth");
});

test("auto compaction triggers at configured pressure and uses hierarchical chunks", async () => {
  appendConversation(18);

  const snapshot = await maybeAutoCompactSession({
    butlerData: tempDir,
    sessionId: "butler/main",
    modelRef: "openai/test",
    budgetOverrides: {
      contextWindowTokens: 700,
      reservedOutputTokens: 10,
      reservedToolTokens: 10,
    },
  });

  expect(snapshot?.trigger).toBe("auto");
  expect(snapshot?.diagnostics).toContain("hierarchical_chunk_compaction");
});

test("auto compaction pressure uses effective post-compaction context instead of raw transcript total", async () => {
  appendConversation(30);

  const budgetOverrides = {
    contextWindowTokens: 6_000,
    reservedOutputTokens: 50,
    reservedToolTokens: 50,
  };
  const first = await maybeAutoCompactSession({
    butlerData: tempDir,
    sessionId: "butler/main",
    modelRef: "openai/test",
    budgetOverrides,
  });
  expect(first?.trigger).toBe("auto");

  appendTranscriptEvent(createTranscriptEvent({
    sessionId: "butler/main",
    eventId: "follow-up-after-compaction",
    kind: "inbound",
    timestamp: new Date(99_000).toISOString(),
    payload: {
      message: {
        text: "짧은 후속 질문입니다.",
      },
    },
  }));

  const second = await maybeAutoCompactSession({
    butlerData: tempDir,
    sessionId: "butler/main",
    modelRef: "openai/test",
    budgetOverrides,
  });

  expect(second).toBeNull();
});

test("concurrent compactions serialize through one append-only snapshot log", async () => {
  appendConversation(8);

  await Promise.all([
    compactTranscript({
      butlerData: tempDir,
      sessionId: "butler/main",
      trigger: "manual",
      preserveLastEvents: 2,
    }),
    compactTranscript({
      butlerData: tempDir,
      sessionId: "butler/main",
      trigger: "repair",
      preserveLastEvents: 2,
    }),
  ]);

  const raw = readFileSync(compactionPath(tempDir, "butler/main"), "utf8")
    .trim()
    .split("\n");
  expect(raw).toHaveLength(2);
  expect(raw.every((line) => JSON.parse(line).status === "ok")).toBe(true);
});

test("compaction writes raw-text-free success and failure telemetry", async () => {
  appendConversation(6);

  const snapshot = await compactTranscript({
    butlerData: tempDir,
    sessionId: "butler/main",
    trigger: "manual",
    preserveLastEvents: 2,
    modelRef: "openai/test",
    budgetOverrides: {
      contextWindowTokens: 900,
      reservedOutputTokens: 20,
      reservedToolTokens: 20,
    },
  });
  writeFailedCompactionDiagnostic({
    butlerData: tempDir,
    sessionId: "butler/main",
    modelRef: "openai/test",
    reason: "SECRET raw diagnostic with user text",
  });

  const metrics = readCompactionMetrics({
    butlerData: tempDir,
    sessionId: "butler/main",
  });
  const rawMetrics = readFileSync(compactionMetricsPath(tempDir), "utf8");

  expect(metrics).toHaveLength(2);
  expect(metrics[0]).toMatchObject({
    schema: "butler.context-compaction-metric.v1",
    sessionId: "butler/main",
    trigger: "manual",
    status: "ok",
    snapshotId: snapshot.snapshot_id,
    rawTextStored: false,
  });
  expect(metrics[0].durationMs).toBeGreaterThanOrEqual(0);
  expect(metrics[0].reductionRatio).toBeGreaterThan(0);
  expect(metrics[1]).toMatchObject({
    status: "failed",
    rawTextStored: false,
  });
  expect(metrics[1].diagnostics[0]).toStartWith("redacted_");
  expect(rawMetrics).not.toContain("사용자 목표");
  expect(rawMetrics).not.toContain("세부사항");
  expect(rawMetrics).not.toContain("SECRET raw diagnostic");
});
