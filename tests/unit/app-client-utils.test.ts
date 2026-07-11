import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import {
  applyTimelineEvents,
  applyTimelineEventsToViewState,
  activeTurnProgressSnapshot,
  clientTurnIdFromMessageId,
  completedTurnActivityRows,
  completedTurnWorkBlocks,
  firstCancellableWorker,
  freezeMessageWorkBlocks,
  groupWorkerActivities,
  hasFollowableWorkerActivity,
  isInternalProgressRow,
  isRuntimeFaultRetryableMessage,
  isVisibleToolchainProgressRow,
  mergeMessages,
  mergeTurnProgressFromSummary,
  mergeTurnProgressSnapshotMap,
  mergeSessionSummaryForPendingTurn,
  isWorkerVisibleInComposer,
  phaseLabel,
  semanticProgressRows,
  shouldShowTurnActivity,
  workerActivityCollapsedSummaryLine,
  workerActivityDisplayName,
  workerActivityDescription,
  workerActivityMeta,
  workerActivityStatusLine,
  typedUiReadModelsFromProgressRows,
  workBlocksFromProgressRows,
} from "../../packages/butler-app/client/ui/src/app/utils.ts";
import {
  browserRandomId,
  browserRandomUUID,
} from "../../packages/butler-app/client/ui/src/app/id.ts";
import { getAppCopy } from "../../packages/butler-app/client/ui/src/app/copy.ts";
import { resolveMarkdownImageSource } from "../../packages/butler-app/client/ui/src/components/conversation/messageMedia.ts";
import {
  createAgentTurnEvent,
  progressRowFromTurnEvent as sharedProgressRowFromTurnEvent,
} from "../../packages/butler-agent/src/agent/events/turn-events.ts";
import type {
  MessageFileRef,
  MessageRecord,
  SessionSummaryView,
  TimelineEvent,
  TurnProgressSnapshot,
  WorkerActivitySummary,
} from "../../packages/butler-app/client/ui/src/app/types.ts";

const originalCrypto = globalThis.crypto;

function withCrypto<T>(crypto: Partial<Crypto> | undefined, run: () => T): T {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: crypto,
    writable: true,
  });
  try {
    return run();
  } finally {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: originalCrypto,
      writable: true,
    });
  }
}

test("browser random ids fall back when randomUUID is unavailable", () => {
  const id = withCrypto(
    {
      getRandomValues(bytes: Uint8Array) {
        bytes.fill(0);
        bytes[15] = 1;
        return bytes;
      },
    },
    () => browserRandomUUID(),
  );

  expect(id).toBe("00000000-0000-4000-8000-000000000001");
});

test("browser random ids still exist when Web Crypto is unavailable", () => {
  const id = withCrypto(undefined, () => browserRandomId("client"));

  expect(id).toMatch(
    /^client-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
});

test("work summary copy keeps public progress suffix language-stable", () => {
  const copy = getAppCopy("en-US").conversation.work;

  expect(copy.collapsedSummary("공개 출처를 확인하는 중", 2)).toBe(
    "공개 출처를 확인하는 중 외 1개 진행 내역",
  );
  expect(copy.expandHistoryLabel("공개 출처를 확인하는 중", 2)).toBe(
    "공개 출처를 확인하는 중 외 1개 진행 내역 열기",
  );
  expect(copy.collapseHistoryLabel("공개 출처를 확인하는 중", 2)).toBe(
    "공개 출처를 확인하는 중 외 1개 진행 내역 닫기",
  );
});

test("message merging preserves unchanged row references", () => {
  const cachedMessage = message("assistant-a", "assistant", 2, "turn-a");
  const current = [message("user-a", "user", 1, "turn-a"), cachedMessage];
  const merged = mergeMessages(current, [
    { ...cachedMessage, attachments: [] },
  ]);

  expect(merged).toBe(current);
  expect(merged[1]).toBe(cachedMessage);
});

test("markdown image sources resolve to attached app-server image files", () => {
  const imageAttachment: MessageFileRef = {
    file_id: "file-11111111-1111-4111-8111-111111111111",
    kind: "image",
    mime_type: "image/jpeg",
    safe_name: "cyrene-official-illustration.jpg",
    size_bytes: 424_688,
    sha256: "sha",
    url: "/message-files/file-11111111-1111-4111-8111-111111111111",
    created_at: "2026-05-29T14:36:59.444Z",
  };
  const documentAttachment: MessageFileRef = {
    ...imageAttachment,
    file_id: "file-22222222-2222-4222-8222-222222222222",
    kind: "text",
    mime_type: "text/markdown",
    safe_name: "cyrene-official-illustration.jpg",
    url: "/message-files/file-22222222-2222-4222-8222-222222222222",
  };

  expect(
    resolveMarkdownImageSource(
      "artifacts/cyrene/cyrene-official-illustration.jpg",
      [documentAttachment, imageAttachment],
    ),
  ).toBe("/message-files/file-11111111-1111-4111-8111-111111111111");
  expect(
    resolveMarkdownImageSource(
      "/message-files/file-11111111-1111-4111-8111-111111111111",
      [imageAttachment],
    ),
  ).toBe("/message-files/file-11111111-1111-4111-8111-111111111111");
  expect(
    resolveMarkdownImageSource("artifacts/other.png", [imageAttachment]),
  ).toBe("artifacts/other.png");
});

test("worker activity labels include consolidation and reporting phases", () => {
  expect(phaseLabel("consolidating")).toBe("Consolidating");
  expect(phaseLabel("reporting")).toBe("Reporting");
});

test("worker activity display groups planned orchestration with worker attempts", () => {
  const plan = worker("planning", false, "2026-05-15T12:30:00.000Z", {
    activity_kind: "planned",
    task_id: "planned-1",
    worker_id: "worker-planned-1",
    worker_label: "Plan",
    orchestration_id: "planned-1",
  });
  const attempt = worker("consolidating", false, "2026-05-15T12:31:00.000Z", {
    task_id: "worker-1",
    worker_id: "worker-worker-1",
    worker_label: "Worker 1",
    orchestration_id: "planned-1",
    status_line: "Consolidating: reviewing README.md.",
    current_activity_title: "README.md 파일을 근거로 정리합니다.",
  });

  expect(groupWorkerActivities([plan, attempt])).toEqual([
    {
      id: "group-planned-1",
      parent: plan,
      workers: [attempt],
    },
  ]);
  expect(workerActivityStatusLine(attempt)).toBe("README.md 파일을 근거로 정리합니다.");
  expect(workerActivityDescription(plan)).toBe(plan.objective);
  expect(workerActivityMeta(plan)).toBe("Planning");
  expect(workerActivityDescription(attempt)).toBe("README.md 파일을 근거로 정리합니다.");
  expect(workerActivityCollapsedSummaryLine(attempt)).toBe(
    "Worker 1 Consolidating: README.md 파일을 근거로 정리합니다.",
  );
  expect(workerActivityMeta(attempt)).toBe("Consolidating");
});

test("worker activity status uses durable activity titles without client-side domain heuristics", () => {
  expect(workerActivityStatusLine(worker("executing", false, "2026-05-15T12:31:00.000Z", {
    status_line: "Executing: reading package.json.",
    current_activity_title: "Reading package.json.",
  }))).toBe("Reading package.json.");
  expect(workerActivityStatusLine(worker("executing", false, "2026-05-15T12:31:00.000Z", {
    status_line: "Executing: searching project files.",
  }))).toBe("Executing: searching project files.");
  expect(workerActivityStatusLine(worker("failed", true, "2026-05-15T12:31:00.000Z", {
    status_line: "Failed: worker reached the tool budget before producing a report.",
  }))).toBe("Failed: worker reached the tool budget before producing a report.");
  expect(workerActivityCollapsedSummaryLine(worker("executing", false, "2026-05-15T12:31:00.000Z", {
    worker_label: "Worker A",
    status_line: "Executing: Aligning composer controls",
  }))).toBe("Worker A Executing: Aligning composer controls");
  expect(workerActivityDescription(worker("executing", false, "2026-05-15T12:31:00.000Z", {
    worker_label: "Worker A",
    status_line: "Executing: Aligning composer controls",
  }))).toBe("Aligning composer controls");
});

test("worker activity labels prefer stable display names with ordinal fallback", () => {
  const named = worker("executing", false, "2026-05-15T12:31:00.000Z", {
    worker_label: "Ari",
    worker_display_name: "Ari",
    worker_ordinal_label: "Worker 1",
    status_line: "Executing: Aligning composer controls",
  });
  const legacy = worker("executing", false, "2026-05-15T12:31:00.000Z", {
    worker_label: "",
    worker_ordinal_label: "Worker 7",
    status_line: "Executing: Checking worker history",
  });
  const genericLegacy = worker("executing", false, "2026-05-15T12:31:00.000Z", {
    worker_label: "Worker",
    worker_ordinal_label: "Worker 8",
    status_line: "Executing: Checking worker history",
  });

  expect(workerActivityDisplayName(named)).toBe("Ari");
  expect(workerActivityCollapsedSummaryLine(named)).toBe(
    "Ari Executing: Aligning composer controls",
  );
  expect(workerActivityDisplayName(legacy)).toBe("Worker 7");
  expect(workerActivityDisplayName(genericLegacy)).toBe("Worker 8");
});

test("app-client worker utilities do not carry runtime-domain status dictionaries", () => {
  const source = Buffer.from(
    readFileSync("packages/butler-app/client/ui/src/app/utils.ts"),
  ).toString("utf8");
  const statusFunction = source.slice(
    source.indexOf("export function workerActivityStatusLine"),
    source.indexOf("export function workerActivityDescription"),
  );
  expect(source).not.toContain("workerExecutionStatus");
  expect(source).not.toContain("localizedEvidenceSubject");
  expect(source).not.toContain("프로젝트 파일을 검색하는 중입니다.");
  expect(source).not.toContain("워커 상태를 확인하는 중입니다.");
  expect(statusFunction).not.toMatch(/project|weather|validation|search|read|file|프로젝트|날씨/iu);
});

test("composer shows only active workers", () => {
  const now = Date.parse("2026-05-15T12:50:00.000Z");

  expect(isWorkerVisibleInComposer(worker("complete", true, "2026-05-15T12:49:00.000Z"), now)).toBe(false);
  expect(isWorkerVisibleInComposer(worker("failed", true, "2026-05-15T12:47:00.000Z"), now)).toBe(false);
  expect(isWorkerVisibleInComposer(worker("failed", true, "2026-05-15T12:30:00.000Z"), now)).toBe(false);
  expect(isWorkerVisibleInComposer(worker("blocked", false, "2026-05-15T12:49:00.000Z"), now)).toBe(false);
  expect(isWorkerVisibleInComposer(worker("recoverable", false, "2026-05-15T12:49:00.000Z"), now)).toBe(false);
  expect(isWorkerVisibleInComposer(worker("planning", false, "2026-05-15T12:30:00.000Z"), now)).toBe(true);
  expect(hasFollowableWorkerActivity([worker("failed", true, "2026-05-15T12:47:00.000Z")], now)).toBe(false);
  expect(hasFollowableWorkerActivity([worker("blocked", false, "2026-05-15T12:47:00.000Z")], now)).toBe(false);
  expect(hasFollowableWorkerActivity([worker("failed", true, "2026-05-15T12:30:00.000Z")], now)).toBe(false);
});

test("turn activity remains visible while worker activity exists", () => {
  const activeWorker = worker(
    "executing",
    false,
    "2026-05-15T12:49:00.000Z",
  );

  expect(isWorkerVisibleInComposer(activeWorker)).toBe(true);
  expect(
    shouldShowTurnActivity({
      activeTurn: true,
      hasTodoProgress: false,
      isSending: false,
      timelineProgressRowCount: 1,
    }),
  ).toBe(true);
  expect(
    shouldShowTurnActivity({
      activeTurn: true,
      hasTodoProgress: true,
      isSending: false,
      timelineProgressRowCount: 1,
    }),
  ).toBe(true);
  expect(
    shouldShowTurnActivity({
      activeTurn: true,
      hasTodoProgress: true,
      isSending: false,
      timelineProgressRowCount: 0,
    }),
  ).toBe(false);
  expect(
    shouldShowTurnActivity({
      activeTurn: true,
      hasTodoProgress: false,
      isSending: false,
      timelineProgressRowCount: 0,
      turnState: "retrying",
    }),
  ).toBe(false);
  expect(
    shouldShowTurnActivity({
      activeTurn: true,
      hasTodoProgress: false,
      isSending: false,
      timelineProgressRowCount: 1,
      turnState: "retrying",
    }),
  ).toBe(true);
});

test("composer can find the active worker cancel target", () => {
  const now = Date.parse("2026-05-15T12:50:00.000Z");
  const staleFailed = worker("failed", true, "2026-05-15T12:30:00.000Z", {
    supported_controls: ["cancel"],
  });
  const running = worker("executing", false, "2026-05-15T12:49:00.000Z", {
    worker_id: "worker-running",
    supported_controls: ["cancel"],
  });

  expect(firstCancellableWorker([staleFailed, running], now)?.worker_id).toBe("worker-running");
  expect(firstCancellableWorker([worker("complete", true, "2026-05-15T12:49:00.000Z")], now)).toBeNull();
});

test("summary progress merging preserves unchanged snapshot references", () => {
  const snapshot: TurnProgressSnapshot = {
    turn_id: "turn-a",
    state: "delivered",
    safe_progress_rows: [
      {
        id: "row-a",
        kind: "ran_command",
        state: "delivered",
        safe_label: "Bash: bun test",
        safe_tool_name: "Bash",
        safe_input_label: "bun test",
        work_block_id: "work-test",
        work_block_label: "테스트 실행 중",
      },
    ],
  };
  const current = { "turn-a": snapshot };
  const merged = mergeTurnProgressFromSummary(current, {
    session_id: "session-a",
    turn_state: "delivered",
    latest_progress: {
      ...snapshot,
      safe_progress_rows: [...snapshot.safe_progress_rows],
    },
  });

  expect(merged).toBe(current);
  expect(merged["turn-a"]).toBe(snapshot);
});

test("completed assistant messages freeze work blocks onto the message record", () => {
  const snapshot: TurnProgressSnapshot = {
    turn_id: "turn-a",
    state: "delivered",
    safe_progress_rows: [
      {
        id: "row-a",
        kind: "ran_command",
        state: "delivered",
        safe_label: "Bash: bun test",
        safe_tool_name: "Bash",
        safe_input_label: "bun test",
        work_block_id: "work-test",
        work_block_label: "테스트 실행 중",
      },
    ],
  };
  const [frozen] = freezeMessageWorkBlocks(
    [message("assistant-a", "assistant", 2, "turn-a")],
    { "turn-a": snapshot },
  );
  const refrozen = freezeMessageWorkBlocks([frozen!], {
    "turn-a": {
      ...snapshot,
      safe_progress_rows: [...snapshot.safe_progress_rows],
    },
  });

  expect(frozen?.work_blocks?.[0]).toMatchObject({
    id: "work-test",
    label: "테스트 실행 중",
  });
  expect(frozen?.work_blocks?.[0]?.rows[0]).toMatchObject({
    id: "row-a",
    kind: "ran_command",
    safe_label: "Bash: bun test",
    safe_tool_name: "Bash",
    safe_input_label: "bun test",
  });
  expect(frozen?.work_blocks?.[0]?.rows[0]?.work_block_id).toBeUndefined();
  expect(frozen?.work_blocks?.[0]?.rows[0]?.work_block_label).toBeUndefined();
  expect(refrozen[0]).toBe(frozen);
});

test("completed assistant messages keep frozen work blocks when progress is absent", () => {
  const snapshot: TurnProgressSnapshot = {
    turn_id: "turn-a",
    state: "delivered",
    safe_progress_rows: [
      {
        id: "row-a",
        kind: "ran_command",
        state: "delivered",
        safe_label: "Bash: bun test",
        safe_tool_name: "Bash",
        safe_input_label: "bun test",
        work_block_id: "work-test",
        work_block_label: "테스트 실행 중",
      },
    ],
  };
  const [frozen] = freezeMessageWorkBlocks(
    [message("assistant-a", "assistant", 2, "turn-a")],
    { "turn-a": snapshot },
  );

  const refrozen = freezeMessageWorkBlocks([frozen!], {});

  expect(refrozen[0]).toBe(frozen);
  expect(refrozen[0]?.work_blocks?.[0]).toMatchObject({
    id: "work-test",
    label: "테스트 실행 중",
  });
  expect(refrozen[0]?.work_blocks?.[0]?.rows[0]).toMatchObject({
    id: "row-a",
    kind: "ran_command",
    safe_label: "Bash: bun test",
    safe_tool_name: "Bash",
    safe_input_label: "bun test",
  });
  expect(refrozen[0]?.work_blocks?.[0]?.rows[0]?.work_block_id).toBeUndefined();
  expect(refrozen[0]?.work_blocks?.[0]?.rows[0]?.work_block_label)
    .toBeUndefined();
});

test("cancelled assistant messages keep completed work evidence", () => {
  const snapshot: TurnProgressSnapshot = {
    turn_id: "turn-cancelled",
    state: "cancelled",
    safe_progress_rows: [
      {
        id: "row-cancelled",
        kind: "ran_command",
        state: "cancelled",
        safe_label: "Bash: npm test",
        safe_tool_name: "Bash",
        safe_input_label: "npm test",
        work_block_id: "work-cancelled",
        work_block_label: "검증 중단 전 실행한 작업",
      },
    ],
  };
  const [frozen] = freezeMessageWorkBlocks(
    [
      {
        ...message("assistant-cancelled", "assistant", 2, "turn-cancelled"),
        status: "cancelled",
      },
    ],
    { "turn-cancelled": snapshot },
  );

  expect(frozen?.work_blocks?.[0]).toMatchObject({
    id: "work-cancelled",
    label: "검증 중단 전 실행한 작업",
    state: "cancelled",
  });
  expect(frozen?.work_blocks?.[0]?.rows).toContainEqual(
    expect.objectContaining({
      id: "row-cancelled",
      state: "cancelled",
      safe_tool_name: "Bash",
    }),
  );
});

test("completed assistant messages retain every completed work block from the turn", () => {
  const snapshot: TurnProgressSnapshot = {
    turn_id: "turn-long",
    state: "delivered",
    safe_progress_rows: Array.from({ length: 8 }, (_, index) => ({
      id: `row-${index}`,
      kind: "ran_command",
      state: "delivered",
      safe_label: `Bash: step ${index + 1}`,
      safe_tool_name: "Bash",
      safe_input_label: `step ${index + 1}`,
      work_block_id: `work-${index}`,
      work_block_label: `작업 단계 ${index + 1}`,
    })),
  };

  const [frozen] = freezeMessageWorkBlocks(
    [message("assistant-long", "assistant", 2, "turn-long")],
    { "turn-long": snapshot },
  );

  expect(frozen?.work_blocks).toHaveLength(8);
  expect(frozen?.work_blocks?.[0]?.label).toBe("작업 단계 1");
  expect(frozen?.work_blocks?.at(-1)?.label).toBe("작업 단계 8");
});

test("delivered assistant messages freeze available running work rows while terminal turn event lags", () => {
  const snapshot: TurnProgressSnapshot = {
    turn_id: "turn-lagging-terminal",
    state: "running",
    safe_progress_rows: [
      {
        id: "row-search",
        kind: "searched",
        state: "running",
        safe_label: "Web search: source",
        safe_tool_name: "Web search",
        safe_input_label: "source",
        work_block_id: "work-search",
        work_block_label: "공식 근거를 확인합니다.",
      },
    ],
  };

  const [frozen] = freezeMessageWorkBlocks(
    [message("assistant-final", "assistant", 2, "turn-lagging-terminal")],
    { "turn-lagging-terminal": snapshot },
  );

  expect(frozen?.work_blocks?.[0]?.label).toBe("공식 근거를 확인합니다.");
  expect(frozen?.work_blocks?.[0]?.rows[0]?.state).toBe("delivered");
});

function summary(
  turnId: string,
  state: string,
  label: string,
  updatedAt = "2026-05-19T00:00:00.000Z",
): SessionSummaryView {
  return {
    session_id: "session-a",
    turn_state: state,
    latest_progress: {
      turn_id: turnId,
      state,
      updated_at: updatedAt,
      safe_progress_rows: [
        {
          id: `row-${turnId}`,
          kind: "thinking",
          state,
          safe_label: label,
        },
      ],
    },
  };
}

test("pending client progress is not overwritten by stale summary polling", () => {
  const pending = summary(
    clientTurnIdFromMessageId("client-message"),
    "thinking",
    "Thinking",
    "2026-05-19T00:01:00.000Z",
  );
  const stale = summary(
    "turn-previous",
    "delivered",
    "Bash: old command",
    "2026-05-19T00:00:00.000Z",
  );

  const merged = mergeSessionSummaryForPendingTurn(pending, stale);

  expect(merged.latest_progress?.turn_id).toBe(
    clientTurnIdFromMessageId("client-message"),
  );
  expect(merged.latest_progress?.safe_progress_rows[0]?.safe_label).toBe(
    "Thinking",
  );
});

test("real active server progress replaces pending client progress", () => {
  const pending = summary(
    clientTurnIdFromMessageId("client-message"),
    "thinking",
    "Thinking",
    "2026-05-19T00:01:00.000Z",
  );
  const active = summary(
    "turn-current",
    "thinking",
    "Bash: bun test",
    "2026-05-19T00:01:01.000Z",
  );

  const merged = mergeSessionSummaryForPendingTurn(pending, active);

  expect(merged.latest_progress?.turn_id).toBe("turn-current");
  expect(merged.latest_progress?.safe_progress_rows[0]?.safe_label).toBe(
    "Bash: bun test",
  );
});

test("real terminal server progress replaces pending client progress", () => {
  const pending = summary(
    clientTurnIdFromMessageId("client-message"),
    "thinking",
    "Thinking",
    "2026-05-19T00:01:00.000Z",
  );
  const delivered = summary(
    "turn-current",
    "delivered",
    "Delivered",
    "2026-05-19T00:01:04.000Z",
  );

  const merged = mergeSessionSummaryForPendingTurn(pending, delivered);

  expect(merged.turn_state).toBe("delivered");
  expect(merged.latest_progress?.turn_id).toBe("turn-current");
  expect(merged.latest_progress?.state).toBe("delivered");
  expect(merged.latest_progress?.safe_progress_rows[0]?.safe_label).toBe(
    "Delivered",
  );
});

test("stale session snapshots cannot revive a terminal turn", () => {
  const delivered = summary(
    "turn-current",
    "delivered",
    "Delivered",
    "2026-05-19T00:01:04.000Z",
  );
  const staleRunning = summary(
    "turn-current",
    "thinking",
    "Thinking",
    "2026-05-19T00:01:02.000Z",
  );
  staleRunning.latest_progress!.safe_progress_rows = [
    {
      id: "late-running-row",
      kind: "thinking",
      state: "thinking",
      safe_label: "Queued for Butler Agent",
      created_at: "2026-05-19T00:01:02.000Z",
    },
  ];

  const merged = mergeSessionSummaryForPendingTurn(delivered, staleRunning);

  expect(merged.turn_state).toBe("delivered");
  expect(merged.latest_progress?.state).toBe("delivered");
  expect(merged.latest_progress?.safe_progress_rows).toContainEqual(
    expect.objectContaining({ id: "row-turn-current", state: "delivered" }),
  );
});

test("stale failed polling does not hide active retry progress", () => {
  const retrying = summary(
    "turn-retry",
    "retrying",
    "Bash: retry attempt",
    "2026-06-03T03:00:11.000Z",
  );
  retrying.latest_progress!.safe_progress_rows = [
    {
      id: "retry-row",
      kind: "ran_command",
      state: "thinking",
      safe_label: "Bash: retry attempt",
      safe_tool_name: "Bash",
      created_at: "2026-06-03T03:00:11.000Z",
    },
  ];
  const staleFailed = summary(
    "turn-retry",
    "failed",
    "Butler could not complete this turn.",
    "2026-06-03T02:55:53.000Z",
  );

  const merged = mergeSessionSummaryForPendingTurn(retrying, staleFailed);

  expect(merged.turn_state).toBe("retrying");
  expect(merged.latest_progress?.state).toBe("retrying");
  expect(merged.latest_progress?.safe_progress_rows).toContainEqual(
    expect.objectContaining({ id: "retry-row", state: "thinking" }),
  );
});

test("stale failed progress snapshots do not replace active retry snapshots", () => {
  const retrySnapshot: TurnProgressSnapshot = {
    turn_id: "turn-retry",
    state: "thinking",
    safe_progress_rows: [
      {
        id: "retry-row",
        kind: "ran_command",
        state: "thinking",
        safe_label: "Bash: retry attempt",
        safe_tool_name: "Bash",
        created_at: "2026-06-03T03:00:11.000Z",
      },
    ],
  };
  const staleFailedSnapshot: TurnProgressSnapshot = {
    turn_id: "turn-retry",
    state: "failed",
    updated_at: "2026-06-03T02:55:53.000Z",
    safe_progress_rows: [
      {
        id: "failed-row",
        kind: "error",
        state: "failed",
        safe_label: "Butler could not complete this turn.",
      },
    ],
  };
  const current = { "turn-retry": retrySnapshot };

  expect(
    mergeTurnProgressFromSummary(current, {
      session_id: "general",
      turn_state: "failed",
      latest_progress: staleFailedSnapshot,
    }),
  ).toBe(current);
  expect(
    mergeTurnProgressSnapshotMap(current, {
      "turn-retry": staleFailedSnapshot,
    }),
  ).toBe(current);
});

test("accepted real turn removes optimistic client turn progress", () => {
  const clientMessageId = "client-message";
  const clientTurnId = clientTurnIdFromMessageId(clientMessageId);
  const state = applyTimelineEventsToViewState(
    [
      {
        id: 1,
        type: "message.created",
        payload: {
          message: {
            id: clientMessageId,
            chat_id: "general",
            turn_id: "turn-real",
            role: "user",
            text: "hello",
            status: "sent",
          },
        },
      },
    ] satisfies TimelineEvent[],
    "general",
    {
      messages: [],
      summary: null,
      turnProgress: {
        [clientTurnId]: {
          turn_id: clientTurnId,
          state: "thinking",
          safe_progress_rows: [
            {
              id: "optimistic",
              kind: "thinking",
              state: "thinking",
              safe_label: "Thinking",
            },
          ],
        },
      },
    },
  );

  expect(state.turnProgress[clientTurnId]).toBeUndefined();
  expect(activeTurnProgressSnapshot(null, state.turnProgress)).toBeNull();
});

test("message deleted events remove stale assistant rows from the active chat", () => {
  const state = applyTimelineEventsToViewState(
    [
      {
        id: 2,
        type: "message.deleted",
        payload: {
          chat_id: "general",
          message_id: "assistant-failure",
          turn_id: "turn-recovered",
        },
      },
    ] satisfies TimelineEvent[],
    "general",
    {
      messages: [
        {
          id: "user-request",
          chat_id: "general",
          turn_id: "turn-recovered",
          role: "user",
          text: "continue",
          status: "sent",
        },
        {
          id: "assistant-failure",
          chat_id: "general",
          turn_id: "turn-recovered",
          role: "assistant",
          text: "Butler did not finish this queued request before the dispatch lease expired.",
          status: "failed",
          retryable: true,
        },
      ],
      summary: null,
      turnProgress: {},
    },
  );

  expect(state.messages.map((message) => message.id)).toEqual(["user-request"]);
});

test("turn acknowledgements replace optimistic Thinking progress immediately", () => {
  const clientMessageId = "client-message";
  const clientTurnId = clientTurnIdFromMessageId(clientMessageId);
  const state = applyTimelineEventsToViewState(
    [
      {
        id: 1,
        type: "agent.turn_event",
        payload: {
          session_id: "general",
          turn_id: "turn-real",
          event: {
            id: "event-ack",
            sessionId: "general",
            turnId: "turn-real",
            sessionSequence: 1,
            turnSequence: 1,
            createdAt: "2026-05-19T00:01:01.000Z",
            kind: "turn.acknowledged",
            visibility: "public",
            payload: {
              safeLabel: "Request received. Preparing the work.",
              transport: "app",
            },
          },
        },
      },
    ] satisfies TimelineEvent[],
    "general",
    {
      messages: [],
      summary: {
        session_id: "general",
        turn_state: "thinking",
        latest_progress: {
          turn_id: clientTurnId,
          state: "thinking",
          updated_at: "2026-05-19T00:01:00.000Z",
          safe_progress_rows: [
            {
              id: "optimistic",
              kind: "thinking",
              state: "thinking",
              safe_label: "Thinking",
              created_at: "2026-05-19T00:01:00.000Z",
            },
          ],
        },
      },
      turnProgress: {
        [clientTurnId]: {
          turn_id: clientTurnId,
          state: "thinking",
          updated_at: "2026-05-19T00:01:00.000Z",
          safe_progress_rows: [
            {
              id: "optimistic",
              kind: "thinking",
              state: "thinking",
              safe_label: "Thinking",
              created_at: "2026-05-19T00:01:00.000Z",
            },
          ],
        },
      },
    },
  );

  expect(state.summary?.latest_progress?.turn_id).toBe("turn-real");
  expect(state.summary?.latest_progress?.state).toBe("accepted");
  expect(
    state.summary?.latest_progress?.safe_progress_rows.map(
      (row) => row.safe_label,
    ),
  ).toEqual(["Request received. Preparing the work."]);
  expect(
    activeTurnProgressSnapshot(state.summary, state.turnProgress),
  ).toMatchObject({
    turn_id: "turn-real",
    state: "accepted",
  });
});

test("app server acknowledgement batch replaces existing session optimistic Thinking", () => {
  const clientMessageId = "client-existing-message";
  const clientTurnId = clientTurnIdFromMessageId(clientMessageId);
  const state = applyTimelineEventsToViewState(
    [
      {
        id: 1,
        type: "message.created",
        payload: {
          message: {
            id: clientMessageId,
            chat_id: "general",
            turn_id: "turn-real",
            role: "user",
            text: "continue",
            status: "sent",
            cursor: 1,
          },
        },
      },
      {
        id: 2,
        type: "agent.turn_event",
        payload: {
          session_id: "general",
          turn_id: "turn-real",
          event: {
            id: "event-ack",
            sessionId: "general",
            turnId: "turn-real",
            sessionSequence: 2,
            turnSequence: 1,
            createdAt: "2026-05-19T00:01:01.000Z",
            kind: "turn.acknowledged",
            visibility: "public",
            payload: {
              safeLabel: "Request received. Preparing the work.",
              transport: "app",
            },
          },
        },
      },
      {
        id: 3,
        type: "agent.turn_event",
        payload: {
          session_id: "general",
          turn_id: "turn-real",
          event: {
            id: "event-started",
            sessionId: "general",
            turnId: "turn-real",
            sessionSequence: 3,
            turnSequence: 2,
            createdAt: "2026-05-19T00:01:02.000Z",
            kind: "turn.started",
            visibility: "public",
            payload: {
              safeLabel: "Started",
            },
          },
        },
      },
    ] satisfies TimelineEvent[],
    "general",
    {
      messages: [],
      summary: {
        session_id: "general",
        turn_state: "thinking",
        latest_progress: {
          turn_id: clientTurnId,
          state: "thinking",
          updated_at: "2026-05-19T00:01:00.000Z",
          safe_progress_rows: [
            {
              id: "optimistic",
              kind: "thinking",
              state: "thinking",
              safe_label: "Thinking",
              created_at: "2026-05-19T00:01:00.000Z",
            },
          ],
        },
      },
      turnProgress: {
        [clientTurnId]: {
          turn_id: clientTurnId,
          state: "thinking",
          updated_at: "2026-05-19T00:01:00.000Z",
          safe_progress_rows: [
            {
              id: "optimistic",
              kind: "thinking",
              state: "thinking",
              safe_label: "Thinking",
              created_at: "2026-05-19T00:01:00.000Z",
            },
          ],
        },
      },
    },
  );

  expect(state.turnProgress[clientTurnId]).toBeUndefined();
  expect(state.summary?.latest_progress?.turn_id).toBe("turn-real");
  expect(state.summary?.latest_progress?.state).toBe("thinking");
  expect(
    state.summary?.latest_progress?.safe_progress_rows.map((row) => row.safe_label),
  ).toEqual(["Request received. Preparing the work.", "Working on request"]);
  expect(activeTurnProgressSnapshot(state.summary, state.turnProgress)).toMatchObject({
    turn_id: "turn-real",
    state: "thinking",
  });
});

test("session starting progress is replaced by first active server turn", () => {
  const clientTurnId = clientTurnIdFromMessageId("client-message");
  const state = applyTimelineEventsToViewState(
    [progressEvent(1, "turn-real", "Bash: bun test")] satisfies TimelineEvent[],
    "general",
    {
      messages: [],
      summary: {
        session_id: "general",
        turn_state: "session_starting",
        latest_progress: {
          turn_id: clientTurnId,
          state: "session_starting",
          safe_progress_rows: [],
        },
      },
      turnProgress: {
        [clientTurnId]: {
          turn_id: clientTurnId,
          state: "session_starting",
          safe_progress_rows: [],
        },
      },
    },
  );

  expect(state.summary?.latest_progress?.turn_id).toBe("turn-real");
  expect(state.summary?.latest_progress?.state).toBe("running");
  expect(
    state.summary?.latest_progress?.safe_progress_rows.map(
      (row) => row.safe_label,
    ),
  ).toEqual(["Bash: bun test"]);
  expect(state.turnProgress[clientTurnId]).toBeUndefined();
  expect(
    activeTurnProgressSnapshot(state.summary, state.turnProgress),
  ).toMatchObject({
    turn_id: "turn-real",
    state: "running",
    safe_progress_rows: [
      expect.objectContaining({ safe_label: "Bash: bun test" }),
    ],
  });
});

test("non-ack old-turn progress does not replace optimistic Thinking progress", () => {
  const clientTurnId = clientTurnIdFromMessageId("client-message");
  const state = applyTimelineEventsToViewState(
    [progressEvent(1, "turn-old", "Old command")] satisfies TimelineEvent[],
    "general",
    {
      messages: [],
      summary: {
        session_id: "general",
        turn_state: "thinking",
        latest_progress: {
          turn_id: clientTurnId,
          state: "thinking",
          safe_progress_rows: [
            {
              id: "optimistic",
              kind: "thinking",
              state: "thinking",
              safe_label: "Thinking",
            },
          ],
        },
      },
      turnProgress: {},
    },
  );

  expect(state.summary?.latest_progress?.turn_id).toBe(clientTurnId);
  expect(state.summary?.latest_progress?.safe_progress_rows).toContainEqual(
    expect.objectContaining({ safe_label: "Thinking" }),
  );
  expect(state.turnProgress["turn-old"]).toBeUndefined();
  expect(
    activeTurnProgressSnapshot(state.summary, state.turnProgress),
  ).toMatchObject({
    turn_id: clientTurnId,
  });
});

test("turn acknowledgements suppress later stale old-turn rows in the same batch", () => {
  const clientTurnId = clientTurnIdFromMessageId("client-message");
  const state = applyTimelineEventsToViewState(
    [
      {
        id: 1,
        type: "agent.turn_event",
        payload: {
          session_id: "general",
          turn_id: "turn-real",
          event: {
            id: "event-ack",
            sessionId: "general",
            turnId: "turn-real",
            sessionSequence: 1,
            turnSequence: 1,
            kind: "turn.acknowledged",
            visibility: "public",
            payload: {
              safeLabel: "Request received. Preparing the work.",
              transport: "app",
            },
          },
        },
      },
      progressEvent(2, "turn-old", "Old command"),
      {
        id: 3,
        type: "message.created",
        payload: {
          message: {
            id: "assistant-final",
            chat_id: "general",
            turn_id: "turn-real",
            role: "assistant",
            text: "done",
            status: "delivered",
            cursor: 2,
          },
        },
      },
    ] satisfies TimelineEvent[],
    "general",
    {
      messages: [],
      summary: {
        session_id: "general",
        turn_state: "thinking",
        latest_progress: {
          turn_id: clientTurnId,
          state: "thinking",
          safe_progress_rows: [
            {
              id: "optimistic",
              kind: "thinking",
              state: "thinking",
              safe_label: "Thinking",
            },
          ],
        },
      },
      turnProgress: {
        [clientTurnId]: {
          turn_id: clientTurnId,
          state: "thinking",
          safe_progress_rows: [
            {
              id: "optimistic",
              kind: "thinking",
              state: "thinking",
              safe_label: "Thinking",
            },
          ],
        },
      },
    },
  );

  expect(state.summary?.latest_progress?.turn_id).toBe("turn-real");
  expect(state.summary?.latest_progress?.safe_progress_rows).toContainEqual(
    expect.objectContaining({
      id: "event-ack",
      safe_label: "Request received. Preparing the work.",
    }),
  );
  expect(state.summary?.latest_progress?.safe_progress_rows).not.toContainEqual(
    expect.objectContaining({ safe_label: "Old command" }),
  );
  expect(state.turnProgress[clientTurnId]).toBeUndefined();
  expect(state.turnProgress["turn-old"]).toBeUndefined();
  expect(
    activeTurnProgressSnapshot(state.summary, state.turnProgress),
  ).toBeNull();
});

test("acknowledged client progress cannot revive Thinking after final delivery", () => {
  const clientTurnId = clientTurnIdFromMessageId("client-message");
  const state = applyTimelineEventsToViewState(
    [
      {
        id: 1,
        type: "agent.turn_event",
        payload: {
          session_id: "general",
          turn_id: "turn-real",
          event: {
            id: "event-ack",
            sessionId: "general",
            turnId: "turn-real",
            sessionSequence: 1,
            turnSequence: 1,
            createdAt: "2026-05-19T00:01:01.000Z",
            kind: "turn.acknowledged",
            visibility: "public",
            payload: {
              safeLabel: "Request received. Preparing the work.",
              transport: "app",
            },
          },
        },
      },
      {
        id: 2,
        type: "message.created",
        payload: {
          message: {
            id: "assistant-final",
            chat_id: "general",
            turn_id: "turn-real",
            role: "assistant",
            text: "done",
            status: "delivered",
            cursor: 2,
          },
        },
      },
    ] satisfies TimelineEvent[],
    "general",
    {
      messages: [],
      summary: {
        session_id: "general",
        turn_state: "thinking",
        latest_progress: {
          turn_id: clientTurnId,
          state: "thinking",
          updated_at: "2026-05-19T00:01:00.000Z",
          safe_progress_rows: [
            {
              id: "optimistic",
              kind: "thinking",
              state: "thinking",
              safe_label: "Thinking",
              created_at: "2026-05-19T00:01:00.000Z",
            },
          ],
        },
      },
      turnProgress: {
        [clientTurnId]: {
          turn_id: clientTurnId,
          state: "thinking",
          updated_at: "2026-05-19T00:01:00.000Z",
          safe_progress_rows: [
            {
              id: "optimistic",
              kind: "thinking",
              state: "thinking",
              safe_label: "Thinking",
              created_at: "2026-05-19T00:01:00.000Z",
            },
          ],
        },
      },
    },
  );

  expect(state.turnProgress[clientTurnId]).toBeUndefined();
  expect(state.turnProgress["turn-real"]?.state).toBe("delivered");
  expect(state.summary?.latest_progress?.state).toBe("delivered");
  expect(
    activeTurnProgressSnapshot(state.summary, state.turnProgress),
  ).toBeNull();
});

test("dedicated client UX contract projects ack, authored decisions, inactive recovery, and completed evidence", () => {
  const clientTurnId = clientTurnIdFromMessageId("client-message");
  const state = applyTimelineEventsToViewState(
    [
      {
        id: 1,
        type: "agent.turn_event",
        payload: {
          session_id: "general",
          turn_id: "turn-real",
          event: {
            id: "event-ack",
            sessionId: "general",
            turnId: "turn-real",
            sessionSequence: 1,
            turnSequence: 1,
            createdAt: "2026-05-19T00:01:01.000Z",
            kind: "turn.acknowledged",
            visibility: "public",
            payload: {
              safeLabel: "Request received. Preparing the work.",
              transport: "app",
            },
          },
        },
      },
      {
        id: 2,
        type: "agent.turn_event",
        payload: {
          session_id: "general",
          turn_id: "turn-real",
          event: {
            id: "event-work-start",
            sessionId: "general",
            turnId: "turn-real",
            sessionSequence: 2,
            turnSequence: 2,
            createdAt: "2026-05-19T00:01:02.000Z",
            kind: "work.block.started",
            visibility: "public",
            payload: {
              workBlockId: "work-validation",
              label: "Validate client turn state",
              decisionSummary: "Validate client turn state",
              decisionRationale:
                "The client must render only authored public decisions.",
              decisionNextStep: "Run the reducer contract check.",
              decisionSource: "assistant-authored",
              decisionEvidenceRefs: ["turn.acknowledged"],
            },
          },
        },
      },
      {
        id: 3,
        type: "agent.turn_event.progress",
        payload: {
          session_id: "general",
          turn_id: "turn-real",
          row: {
            id: "runtime-fallback",
            kind: "work_block",
            state: "running",
            safe_label: "Runtime fallback",
            work_block_id: "work-runtime",
            work_decision_summary: "This must stay hidden.",
            work_decision_source: "runtime-derived",
          },
        },
      },
      {
        id: 4,
        type: "agent.turn_event",
        payload: {
          session_id: "general",
          turn_id: "turn-real",
          event: {
            id: "event-tool-completed",
            sessionId: "general",
            turnId: "turn-real",
            sessionSequence: 3,
            turnSequence: 3,
            createdAt: "2026-05-19T00:01:03.000Z",
            kind: "tool.completed",
            visibility: "public",
            payload: {
              toolName: "Bash",
              inputLabel: "bun test tests/unit/app-client-utils.test.ts",
              safeLabel: "Bash: bun test tests/unit/app-client-utils.test.ts",
              activityKind: "ran_command",
              toolCallId: "tool-test",
              workBlockId: "work-validation",
              workBlockLabel: "Validate client turn state",
            },
          },
        },
      },
      {
        id: 5,
        type: "message.created",
        payload: {
          message: {
            id: "assistant-final",
            chat_id: "general",
            turn_id: "turn-real",
            role: "assistant",
            text: "완료했습니다.",
            status: "delivered",
            cursor: 2,
          },
        },
      },
    ] satisfies TimelineEvent[],
    "general",
    {
      messages: [],
      summary: {
        session_id: "general",
        turn_state: "thinking",
        latest_progress: {
          turn_id: clientTurnId,
          state: "thinking",
          safe_progress_rows: [
            {
              id: "optimistic",
              kind: "thinking",
              state: "thinking",
              safe_label: "Thinking",
            },
          ],
        },
      },
      turnProgress: {},
    },
  );

  const labels =
    state.summary?.latest_progress?.safe_progress_rows.map(
      (row) => row.safe_label,
    ) ?? [];
  expect(state.summary?.latest_progress?.turn_id).toBe("turn-real");
  expect(state.summary?.latest_progress?.state).toBe("delivered");
  expect(labels).not.toContain("Thinking");
  expect(labels).toContain("Request received. Preparing the work.");
  expect(
    isWorkerVisibleInComposer(
      worker("recoverable", false, "2026-05-19T00:01:04.000Z"),
    ),
  ).toBe(false);
  expect(
    activeTurnProgressSnapshot(state.summary, state.turnProgress),
  ).toBeNull();
  expect(state.messages[0]?.work_blocks).toEqual([
    expect.objectContaining({
      id: "work-validation",
      label: "Validate client turn state",
      state: "delivered",
      decision_summary: "Validate client turn state",
      decision_rationale:
        "The client must render only authored public decisions.",
      decision_next_step: "Run the reducer contract check.",
      decision_source: "assistant-authored",
      decision_evidence_refs: ["turn.acknowledged"],
      rows: [
        expect.objectContaining({
          id: "event-tool-completed",
          state: "delivered",
          safe_tool_name: "Bash",
          safe_input_label: "bun test tests/unit/app-client-utils.test.ts",
        }),
      ],
    }),
  ]);
  expect(JSON.stringify(state.messages[0]?.work_blocks)).not.toContain(
    "This must stay hidden.",
  );
});

test("delivered assistant message terminalizes active turn progress immediately", () => {
  const state = applyTimelineEventsToViewState(
    [
      {
        id: 1,
        type: "message.created",
        payload: {
          message: {
            id: "assistant-final",
            chat_id: "general",
            turn_id: "turn-final",
            role: "assistant",
            text: "done",
            status: "delivered",
          },
        },
      },
    ] satisfies TimelineEvent[],
    "general",
    {
      messages: [],
      summary: {
        session_id: "general",
        turn_state: "thinking",
        latest_progress: {
          turn_id: "turn-final",
          state: "thinking",
          safe_progress_rows: [
            {
              id: "running-row",
              kind: "thinking",
              state: "thinking",
              safe_label: "Thinking",
            },
          ],
        },
      },
      turnProgress: {
        "turn-final": {
          turn_id: "turn-final",
          state: "thinking",
          safe_progress_rows: [
            {
              id: "running-row",
              kind: "thinking",
              state: "thinking",
              safe_label: "Thinking",
            },
          ],
        },
      },
    },
  );

  expect(state.turnProgress["turn-final"]?.state).toBe("delivered");
  expect(state.summary?.latest_progress?.state).toBe("delivered");
  expect(activeTurnProgressSnapshot(state.summary, state.turnProgress)).toBeNull();
});

test("retrying turn deletes the failure message and continues existing work progress", () => {
  const openingRow = {
    id: "opening-retry",
    kind: "decision",
    state: "running",
    safe_label: "I will keep the retry on the same turn.",
    public_decision_role: "opening",
    public_decision_summary: "I will keep the retry on the same turn.",
    public_decision_rationale:
      "Retry must continue existing typed progress instead of cloning blocks.",
    public_decision_next_step: "Run the retry attempt.",
    public_decision_source: "model-authored",
  } as const;
  const failedRow = {
    id: "row-retry",
    kind: "ran_command",
    state: "failed",
    safe_label: "Bash: previous attempt",
    safe_tool_name: "Bash",
    safe_input_label: "npm test",
    tool_call_id: "tool-retry",
    work_block_id: "work-retry",
    work_block_label: "Fixing the failing test",
  } as const;
  const state = applyTimelineEventsToViewState(
    [
      {
        id: 1,
        type: "turn.state_changed",
        payload: {
          turn: {
            id: "turn-retry",
            chat_id: "general",
            state: "retrying",
            safe_status_label: "Retrying",
          },
        },
      },
      {
        id: 2,
        type: "message.deleted",
        payload: {
          message_id: "assistant-failed",
          chat_id: "general",
          turn_id: "turn-retry",
          role: "assistant",
        },
      },
      {
        id: 3,
        type: "agent.turn_event.progress",
        payload: {
          session_id: "general",
          turn_id: "turn-retry",
          row: {
            ...failedRow,
            state: "thinking",
            safe_label: "Bash: retry attempt",
          },
        },
      },
    ] satisfies TimelineEvent[],
    "general",
    {
      messages: [
        {
          id: "assistant-failed",
          chat_id: "general",
          turn_id: "turn-retry",
          role: "assistant",
          text: "Butler could not complete this turn.",
          status: "failed",
        },
      ],
      summary: {
        session_id: "general",
        turn_state: "failed",
        latest_progress: {
          turn_id: "turn-retry",
          state: "failed",
          safe_progress_rows: [openingRow, failedRow],
        },
      },
      turnProgress: {
        "turn-retry": {
          turn_id: "turn-retry",
          state: "failed",
          safe_progress_rows: [openingRow, failedRow],
        },
      },
    },
  );

  expect(state.messages).toEqual([]);
  expect(state.turnProgress["turn-retry"]?.state).toBe("thinking");
  expect(state.turnProgress["turn-retry"]?.safe_progress_rows).toHaveLength(2);
  expect(state.turnProgress["turn-retry"]?.safe_progress_rows).toContainEqual(
    expect.objectContaining({
      id: "opening-retry",
      kind: "decision",
      public_decision_summary: "I will keep the retry on the same turn.",
    }),
  );
  expect(state.turnProgress["turn-retry"]?.safe_progress_rows).toContainEqual(
    expect.objectContaining({
      id: "row-retry",
      state: "thinking",
      safe_label: "Bash: retry attempt",
      work_block_id: "work-retry",
    }),
  );
  expect(activeTurnProgressSnapshot(state.summary, state.turnProgress)).toMatchObject({
    turn_id: "turn-retry",
    state: "thinking",
  });
});

test("timeline applies public turn events as progress rows", () => {
  let messages: MessageRecord[] = [];
  let currentSummary: SessionSummaryView | null = {
    session_id: "general",
    turn_state: "thinking",
    latest_progress: {
      turn_id: "turn-1",
      safe_progress_rows: [],
    },
  };

  applyTimelineEvents(
    [
      {
        id: 1,
        type: "agent.turn_event",
        payload: {
          session_id: "general",
          turn_id: "turn-1",
          event: {
            id: "event-tool-started",
            sessionId: "general",
            turnId: "turn-1",
            sessionSequence: 1,
            turnSequence: 1,
            kind: "tool.started",
            visibility: "public",
            payload: {
              activityKind: "ran_command",
              toolName: "Bash",
              inputLabel: "bun test",
              safeLabel: "Bash: bun test",
              bridgePhase: "invoke",
            },
          },
        },
      },
    ] satisfies TimelineEvent[],
    "general",
    (update) => {
      messages = update(messages);
    },
    (update) => {
      currentSummary = update(currentSummary);
      return currentSummary;
    },
  );

  expect(currentSummary?.latest_progress?.safe_progress_rows).toContainEqual(
    expect.objectContaining({
      id: "event-tool-started",
      kind: "ran_command",
      safe_tool_name: "Bash",
      safe_input_label: "bun test",
      bridge_phase: "invoke",
    }),
  );
  expect(messages).toEqual([]);
});

test("delivered terminal progress supersedes same-turn failed terminal rows", () => {
  let currentSummary: SessionSummaryView | null = {
    session_id: "general",
    turn_state: "thinking",
    latest_progress: {
      turn_id: "turn-recoverable",
      state: "thinking",
      safe_progress_rows: [],
    },
  };
  let turnProgress: Record<string, TurnProgressSnapshot> = {};

  const state = applyTimelineEventsToViewState(
    [
      {
        id: 1,
        type: "agent.turn_event",
        payload: {
          session_id: "general",
          turn_id: "turn-recoverable",
          event: {
            id: "event-turn-failed",
            sessionId: "general",
            turnId: "turn-recoverable",
            sessionSequence: 1,
            turnSequence: 1,
            kind: "turn.failed",
            visibility: "public",
            payload: {
              safeLabel: "Failed",
              safeErrorCode: "inbound_dispatch_timeout",
            },
          },
        },
      },
      {
        id: 2,
        type: "agent.turn_event",
        payload: {
          session_id: "general",
          turn_id: "turn-recoverable",
          event: {
            id: "event-tool-failed",
            sessionId: "general",
            turnId: "turn-recoverable",
            sessionSequence: 1,
            turnSequence: 2,
            kind: "tool.failed",
            visibility: "public",
            payload: {
              activityKind: "ran_command",
              toolName: "Bash",
              inputLabel: "bun test",
              safeLabel: "Bash: bun test",
            },
          },
        },
      },
      {
        id: 3,
        type: "message.updated",
        payload: {
          message: {
            id: "assistant-recoverable",
            chat_id: "general",
            turn_id: "turn-recoverable",
            role: "assistant",
            text: "진행한 내용은 보존했습니다.",
            status: "delivered",
            retryable: false,
            cursor: 2,
          },
        },
      },
    ] satisfies TimelineEvent[],
    "general",
    {
      messages: [],
      summary: currentSummary,
      turnProgress,
    },
  );

  currentSummary = state.summary;
  turnProgress = state.turnProgress;

  expect(currentSummary?.latest_progress?.state).toBe("delivered");
  expect(currentSummary?.latest_progress?.safe_progress_rows).not.toContainEqual(
    expect.objectContaining({ kind: "turn", state: "failed" }),
  );
  expect(currentSummary?.latest_progress?.safe_progress_rows).toContainEqual(
    expect.objectContaining({
      id: "event-tool-failed",
      kind: "ran_command",
      state: "failed",
    }),
  );
  expect(turnProgress["turn-recoverable"]?.state).toBe("delivered");
  expect(turnProgress["turn-recoverable"]?.safe_progress_rows).not.toContainEqual(
    expect.objectContaining({ kind: "turn", state: "failed" }),
  );
  expect(turnProgress["turn-recoverable"]?.safe_progress_rows).toContainEqual(
    expect.objectContaining({
      id: "event-tool-failed",
      kind: "ran_command",
      state: "failed",
    }),
  );
});

test("delivered terminal progress preserves same-turn cancelled terminal rows", () => {
  const state = applyTimelineEventsToViewState(
    [
      {
        id: 1,
        type: "agent.turn_event",
        payload: {
          session_id: "general",
          turn_id: "turn-cancelled-evidence",
          event: {
            id: "event-turn-cancelled",
            sessionId: "general",
            turnId: "turn-cancelled-evidence",
            sessionSequence: 1,
            turnSequence: 1,
            kind: "turn.cancelled",
            visibility: "public",
            payload: {
              safeLabel: "Cancelled",
            },
          },
        },
      },
      {
        id: 2,
        type: "message.updated",
        payload: {
          message: {
            id: "assistant-delivered",
            chat_id: "general",
            turn_id: "turn-cancelled-evidence",
            role: "assistant",
            text: "진행한 내용은 보존했습니다.",
            status: "delivered",
            retryable: false,
            cursor: 2,
          },
        },
      },
    ] satisfies TimelineEvent[],
    "general",
    {
      messages: [],
      summary: {
        session_id: "general",
        turn_state: "thinking",
        latest_progress: {
          turn_id: "turn-cancelled-evidence",
          state: "thinking",
          safe_progress_rows: [],
        },
      },
      turnProgress: {},
    },
  );

  expect(state.summary?.latest_progress?.state).toBe("delivered");
  expect(state.summary?.latest_progress?.safe_progress_rows).toContainEqual(
    expect.objectContaining({
      id: "event-turn-cancelled",
      kind: "turn",
      state: "cancelled",
    }),
  );
  expect(
    state.turnProgress["turn-cancelled-evidence"]?.safe_progress_rows,
  ).toContainEqual(
    expect.objectContaining({
      id: "event-turn-cancelled",
      kind: "turn",
      state: "cancelled",
    }),
  );
});

test("timeline keeps per-turn progress snapshots separate across live turns", () => {
  let messages: MessageRecord[] = [];
  let currentSummary: SessionSummaryView | null = {
    session_id: "general",
    turn_state: "delivered",
    latest_progress: {
      turn_id: "turn-old",
      safe_progress_rows: [],
    },
  };
  let turnProgress: Record<string, TurnProgressSnapshot> = {};

  const apply = (events: TimelineEvent[]) =>
    applyTimelineEvents(
      events,
      "general",
      (update) => {
        messages = update(messages);
      },
      (update) => {
        currentSummary = update(currentSummary);
        return currentSummary;
      },
      (update) => {
        turnProgress = update(turnProgress);
        return turnProgress;
      },
    );

  apply([
    {
      id: 1,
      type: "agent.turn_event.progress",
      payload: {
        session_id: "general",
        turn_id: "turn-old",
        row: {
          id: "old-work",
          kind: "work_block",
          state: "delivered",
          safe_label: "이전 자료를 확인했습니다.",
          work_block_id: "work-old",
          work_block_label: "이전 자료를 확인했습니다.",
        },
      },
    },
    {
      id: 2,
      type: "agent.turn_event.progress",
      payload: {
        session_id: "general",
        turn_id: "turn-old",
        row: {
          id: "old-tool",
          kind: "searched",
          state: "delivered",
          safe_label: "Web search: old",
          safe_tool_name: "Web search",
          safe_input_label: "old",
          tool_call_id: "tool-old",
          work_block_id: "work-old",
        },
      },
    },
  ] satisfies TimelineEvent[]);

  apply([
    {
      id: 3,
      type: "agent.turn_event.progress",
      payload: {
        session_id: "general",
        turn_id: "turn-new",
        row: {
          id: "new-work",
          kind: "work_block",
          state: "running",
          safe_label: "새 자료를 확인하고 있습니다.",
          work_block_id: "work-new",
          work_block_label: "새 자료를 확인하고 있습니다.",
        },
      },
    },
  ] satisfies TimelineEvent[]);

  expect(currentSummary?.latest_progress?.turn_id).toBe("turn-new");
  expect(
    completedTurnWorkBlocks(turnProgress["turn-old"]?.safe_progress_rows ?? []),
  ).toEqual([
    expect.objectContaining({
      id: "work-old",
      label: "이전 자료를 확인했습니다.",
      rows: [expect.objectContaining({ safe_input_label: "old" })],
    }),
  ]);
  expect(
    workBlocksFromProgressRows(
      turnProgress["turn-new"]?.safe_progress_rows ?? [],
    )[0]?.label,
  ).toBe("새 자료를 확인하고 있습니다.");
});

test("semantic progress hides internal todo toolchain rows", () => {
  const rows = [
    {
      id: "todo-tool",
      kind: "used_tool",
      state: "delivered",
      safe_label: "Update Todo List",
      safe_tool_name: "Update Todo List",
    },
    {
      id: "semantic-todo",
      kind: "todo",
      state: "running",
      safe_label: "자료 수집하기",
    },
  ];

  expect(isInternalProgressRow(rows[0]!)).toBe(true);
  expect(semanticProgressRows(rows)).toEqual([
    expect.objectContaining({
      kind: "todo",
      safe_label: "자료 수집하기",
    }),
  ]);
  expect(completedTurnActivityRows(rows)).toEqual([]);
});

test("todo progress is not promoted into completed work blocks", () => {
  const blocks = completedTurnWorkBlocks([
    {
      id: "todo-conception",
      kind: "todo",
      state: "delivered",
      safe_label: "Frame the user's WorkStream validation intent",
      safe_detail_rows: [
        {
          id: "phase",
          kind: "phase",
          safe_label: "Phase",
          safe_value: "Conception",
          state: "delivered",
        },
      ],
    },
  ]);

  expect(blocks).toEqual([]);
});

test("final answer freeze does not attach todo-only stages as work blocks", () => {
  const [assistant] = freezeMessageWorkBlocks(
    [
      {
        id: "assistant-final",
        chat_id: "general",
        role: "assistant",
        text: "최종 답변입니다.",
        status: "delivered",
        turn_id: "turn-final",
        created_at: "2026-05-22T10:00:00.000Z",
      },
    ],
    {
      "turn-final": {
        turn_id: "turn-final",
        state: "delivered",
        safe_progress_rows: [
          {
            id: "todo-conception",
            kind: "todo",
            state: "delivered",
            safe_label: "요청 의도 확인",
            safe_detail_rows: [
              {
                id: "phase",
                kind: "phase",
                safe_label: "Phase",
                safe_value: "Conception",
                state: "delivered",
              },
            ],
          },
          {
            id: "todo-reporting",
            kind: "todo",
            state: "delivered",
            safe_label: "사용자에게 보고",
            safe_detail_rows: [
              {
                id: "phase",
                kind: "phase",
                safe_label: "Phase",
                safe_value: "Reporting",
                state: "delivered",
              },
            ],
          },
        ],
      },
    },
  );

  expect(assistant?.work_blocks).toBeUndefined();
});

test("message merge drops stale todo-only frozen work blocks", () => {
  const previous: MessageRecord = {
    id: "assistant-stale",
    chat_id: "general",
    role: "assistant",
    text: "이미 표시된 답변입니다.",
    status: "delivered",
    turn_id: "turn-stale",
    work_blocks: [
      {
        id: "work-todo-conception",
        label: "요청 의도 확인",
        state: "delivered",
        rows: [
          {
            id: "todo-conception",
            kind: "todo",
            state: "delivered",
            safe_label: "요청 의도 확인",
            safe_detail_rows: [
              {
                id: "phase",
                kind: "phase",
                safe_label: "Phase",
                safe_value: "Conception",
                state: "delivered",
              },
            ],
          },
        ],
      },
    ],
  };

  const [merged] = mergeMessages([previous], [{
    id: "assistant-stale",
    chat_id: "general",
    role: "assistant",
    text: "이미 표시된 답변입니다.",
    status: "delivered",
    turn_id: "turn-stale",
  }]);

  expect(merged?.work_blocks).toBeUndefined();
});

test("lifecycle-only progress rows are not promoted into work blocks", () => {
  expect(
    workBlocksFromProgressRows([
      {
        id: "queued",
        kind: "thinking",
        state: "thinking",
        safe_label: "Queued for Butler Agent",
      },
      {
        id: "final-started",
        kind: "message",
        state: "running",
        safe_label: "Preparing final answer",
      },
    ]),
  ).toEqual([]);
});

test("runtime model preparation progress is not promoted into visible work blocks", () => {
  const snapshot: TurnProgressSnapshot = {
    turn_id: "turn-preparation-only",
    state: "delivered",
    safe_progress_rows: [
      {
        id: "prep-turn-event",
        kind: "model",
        state: "delivered",
        safe_label: "응답 준비 중",
        safe_tool_name: "모델 준비",
        work_block_label: "응답 준비 중",
      },
      {
        id: "prep-intermediate",
        kind: "model",
        state: "delivered",
        safe_label: "응답 준비 중",
        safe_tool_name: "모델 준비",
        work_block_label: "응답 준비 중",
      },
    ],
  };

  const [frozen] = freezeMessageWorkBlocks(
    [message("assistant-preparation", "assistant", 2, "turn-preparation-only")],
    { "turn-preparation-only": snapshot },
  );

  expect(workBlocksFromProgressRows(snapshot.safe_progress_rows)).toEqual([]);
  expect(frozen?.work_blocks).toBeUndefined();
});

test("semantic progress rows merge running and delivered todo updates", () => {
  const rows = semanticProgressRows([
    {
      id: "todo-running",
      kind: "todo",
      state: "running",
      safe_label: "프로젝트 메타정보와 구조 확인 중",
      safe_input_label: "inspect",
    },
    {
      id: "todo-delivered",
      kind: "todo",
      state: "delivered",
      safe_label: "프로젝트 메타정보와 구조 확인",
      safe_input_label: "inspect",
    },
  ]);

  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id: "todo-delivered",
    state: "delivered",
    safe_label: "프로젝트 메타정보와 구조 확인",
  });
});

test("authoritative summary replaces legacy live todo rows without identity", () => {
  const current = {
    "turn-wcap": {
      turn_id: "turn-wcap",
      state: "thinking",
      safe_progress_rows: [
        {
          id: "turn-event-old",
          kind: "todo",
          state: "running",
          safe_label: "T-WCAP-01 타입 확장 검증 중",
          safe_order: 1,
        },
      ],
    },
  };

  const merged = mergeTurnProgressFromSummary(current, {
    session_id: "sandy",
    turn_state: "thinking",
    latest_progress: {
      turn_id: "turn-wcap",
      state: "thinking",
      safe_progress_rows: [
        {
          id: "wcap-1",
          kind: "todo",
          state: "delivered",
          safe_label: "T-WCAP-01: ToolAttachment 타입 확장 검증",
          safe_input_label: "wcap-1",
          safe_order: 1,
        },
      ],
    },
  });

  expect(merged["turn-wcap"]?.safe_progress_rows).toEqual([
    {
      id: "wcap-1",
      kind: "todo",
      state: "delivered",
      safe_label: "T-WCAP-01: ToolAttachment 타입 확장 검증",
      safe_input_label: "wcap-1",
      safe_order: 1,
    },
  ]);
});

test("todo composer updates one captured Sandy row by stable identity", async () => {
  const { todoRowsForDisplay } = await import(
    "../../packages/butler-app/client/ui/src/components/conversation/todoComposerRows.ts",
  );
  const liveRow = sharedProgressRowFromTurnEvent(
    createAgentTurnEvent({
      sessionId: "sandy",
      turnId: "turn-wcap",
      sessionSequence: 1,
      turnSequence: 1,
      kind: "tool.progress",
      payload: {
        activityKind: "todo",
        inputLabel: "wcap-1",
        safeLabel: "T-WCAP-01 타입 확장 검증 중",
        state: "running",
        safeOrder: 1,
      },
    }),
  );

  expect(liveRow).not.toBeNull();
  const rows = todoRowsForDisplay([
    liveRow!,
    {
      id: "wcap-1",
      kind: "todo",
      state: "delivered",
      safe_label: "T-WCAP-01: ToolAttachment 타입 확장 검증",
      safe_input_label: "wcap-1",
      safe_order: 1,
    },
  ]);

  expect(rows).toEqual([
    {
      id: "wcap-1",
      label: "T-WCAP-01: ToolAttachment 타입 확장 검증",
      state: "completed",
    },
  ]);
});

test("captured Sandy todo transitions keep six rows across live and replay", async () => {
  const { todoRowsForDisplay } = await import(
    "../../packages/butler-app/client/ui/src/components/conversation/todoComposerRows.ts",
  );
  const initialLabels = [
    "T-WCAP-01 타입 확장 검증 중",
    "T-WCAP-02: web-capture.ts 캡처 엔진 typecheck 에러 수정",
    "T-WCAP-03: 레지스트리 등록 + 로깅 이벤트 추가 + binding 연동",
    "T-WCAP-04: Discord 첨부 전송 연동 + 통합 테스트 + lint + 커밋",
    "전체 typecheck + lint + 테스트 통과 검증",
    "최종 보고",
  ];
  const liveRows = initialLabels.map((safeLabel, index) =>
    sharedProgressRowFromTurnEvent(
      createAgentTurnEvent({
        sessionId: "sandy",
        turnId: "turn-wcap",
        sessionSequence: index + 1,
        turnSequence: index + 1,
        kind: "tool.progress",
        payload: {
          activityKind: "todo",
          inputLabel: `wcap-${index + 1}`,
          safeLabel,
          state: index === 0 ? "running" : "accepted",
          safeOrder: index + 1,
        },
      }),
    ),
  );
  expect(liveRows.every(Boolean)).toBe(true);

  const replayRows = [
    ["T-WCAP-01: ToolAttachment 타입 확장 검증", "delivered"],
    ["T-WCAP-02: web-capture.ts 캡처 엔진 lint 에러 수정", "delivered"],
    ["레지스트리 등록 + 로깅 + binding", "running"],
    ["T-WCAP-04: Discord 첨부 전송 + 통합 테스트 + lint + 커밋", "accepted"],
    ["전체 typecheck + lint + 테스트 통과 검증", "accepted"],
    ["최종 보고", "accepted"],
  ].map(([safeLabel, state], index) => ({
    id: `wcap-${index + 1}`,
    kind: "todo",
    state,
    safe_label: safeLabel!,
    safe_input_label: `wcap-${index + 1}`,
    safe_order: index + 1,
  }));

  const rows = todoRowsForDisplay([
    ...(liveRows.filter(Boolean) as NonNullable<(typeof liveRows)[number]>[]),
    ...replayRows,
  ]);

  expect(rows).toHaveLength(6);
  expect(rows.map((row) => row.id)).toEqual([
    "wcap-1",
    "wcap-2",
    "wcap-3",
    "wcap-4",
    "wcap-5",
    "wcap-6",
  ]);
  expect(rows.slice(0, 4)).toEqual([
    {
      id: "wcap-1",
      label: "T-WCAP-01: ToolAttachment 타입 확장 검증",
      state: "completed",
    },
    {
      id: "wcap-2",
      label: "T-WCAP-02: web-capture.ts 캡처 엔진 lint 에러 수정",
      state: "completed",
    },
    {
      id: "wcap-3",
      label: "레지스트리 등록 + 로깅 + binding",
      state: "running",
    },
    {
      id: "wcap-4",
      label: "T-WCAP-04: Discord 첨부 전송 + 통합 테스트 + lint + 커밋",
      state: "pending",
    },
  ]);
});

test("todo composer does not collapse different ids with the same label", async () => {
  const { todoRowsForDisplay } = await import(
    "../../packages/butler-app/client/ui/src/components/conversation/todoComposerRows.ts",
  );
  const rows = todoRowsForDisplay([
    {
      id: "todo-a",
      kind: "todo",
      state: "accepted",
      safe_label: "동일한 작업",
      safe_input_label: "todo-a",
      safe_order: 1,
    },
    {
      id: "todo-b",
      kind: "todo",
      state: "accepted",
      safe_label: "동일한 작업",
      safe_input_label: "todo-b",
      safe_order: 2,
    },
  ]);

  expect(rows.map((row) => row.id)).toEqual(["todo-a", "todo-b"]);
});

test("semantic progress rows keep todo list order from safe order", () => {
  const rows = semanticProgressRows([
    {
      id: "todo-spec",
      kind: "todo",
      state: "accepted",
      safe_label: "스펙 작성",
      safe_input_label: "spec",
      safe_order: 3,
    },
    {
      id: "todo-scope",
      kind: "todo",
      state: "delivered",
      safe_label: "범위 확인",
      safe_input_label: "scope",
      safe_order: 1,
    },
    {
      id: "todo-name",
      kind: "todo",
      state: "running",
      safe_label: "작업 이름 정리",
      safe_input_label: "name",
      safe_order: 2,
    },
  ]);

  expect(rows.map((row) => row.safe_input_label)).toEqual([
    "scope",
    "name",
    "spec",
  ]);
});

test("todo composer rows keep ordered steps across repeated stable projections", async () => {
  const { todoRowsForDisplay } = await import(
    "../../packages/butler-app/client/ui/src/components/conversation/todoComposerRows.ts",
  );
  const rows = todoRowsForDisplay([
    {
      id: "event-review",
      kind: "todo",
      state: "accepted",
      safe_label: "검토",
      safe_input_label: "review",
      safe_order: 3,
    },
    {
      id: "summary-review",
      kind: "todo",
      state: "accepted",
      safe_label: "검토",
      safe_input_label: "review",
      safe_order: 3,
    },
    {
      id: "event-plan",
      kind: "todo",
      state: "running",
      safe_label: "계획",
      safe_input_label: "plan",
      safe_order: 1,
    },
    {
      id: "summary-plan",
      kind: "todo",
      state: "running",
      safe_label: "계획",
      safe_input_label: "plan",
      safe_order: 1,
    },
    {
      id: "event-report",
      kind: "todo",
      state: "pending",
      safe_label: "보고",
      safe_input_label: "report",
      safe_order: 4,
    },
    {
      id: "summary-report",
      kind: "todo",
      state: "pending",
      safe_label: "보고",
      safe_input_label: "report",
      safe_order: 4,
    },
    {
      id: "event-spec",
      kind: "todo",
      state: "delivered",
      safe_label: "스펙",
      safe_input_label: "spec",
      safe_order: 0,
    },
    {
      id: "summary-spec",
      kind: "todo",
      state: "delivered",
      safe_label: "스펙",
      safe_input_label: "spec",
      safe_order: 0,
    },
    {
      id: "event-code",
      kind: "todo",
      state: "pending",
      safe_label: "구현",
      safe_input_label: "code",
      safe_order: 2,
    },
    {
      id: "summary-code",
      kind: "todo",
      state: "pending",
      safe_label: "구현",
      safe_input_label: "code",
      safe_order: 2,
    },
  ]);

  expect(rows.map((row) => row.label)).toEqual([
    "스펙",
    "계획",
    "구현",
    "검토",
    "보고",
  ]);
});

test("todo composer rows do not infer identity from matching labels", async () => {
  const { todoRowsForDisplay } = await import(
    "../../packages/butler-app/client/ui/src/components/conversation/todoComposerRows.ts",
  );
  const rows = todoRowsForDisplay([
    {
      id: "inspect",
      kind: "todo",
      safe_label: "파일 구조 확인",
      safe_input_label: "inspect",
      state: "running",
    },
    {
      id: "inspect-compat",
      kind: "todo",
      safe_label: "파일 구조 확인",
      state: "running",
    },
  ]);

  expect(rows).toEqual([
    {
      id: "inspect",
      label: "파일 구조 확인",
      state: "running",
    },
    {
      id: "inspect-compat",
      label: "파일 구조 확인",
      state: "running",
    },
  ]);
});

test("active turn progress can render from turnProgress when summary is missing", () => {
  const snapshot = activeTurnProgressSnapshot(null, {
    "turn-a": {
      turn_id: "turn-a",
      state: "running",
      safe_progress_rows: [
        {
          id: "row-a",
          kind: "searched",
          state: "running",
          safe_label: "공식 근거를 찾습니다.",
          safe_tool_name: "Web search",
        },
      ],
    },
  });

  expect(snapshot?.turn_id).toBe("turn-a");
  expect(snapshot?.safe_progress_rows).toHaveLength(1);
});

test("terminal turn progress does not revive stale running child rows", () => {
  const snapshot = activeTurnProgressSnapshot(null, {
    "turn-a": {
      turn_id: "turn-a",
      state: "delivered",
      safe_progress_rows: [
        {
          id: "row-a",
          kind: "searched",
          state: "running",
          safe_label: "Web search: stale",
          safe_tool_name: "Web search",
        },
      ],
    },
  });

  expect(snapshot).toBeNull();
});

test("work blocks group chained tools by semantic work block label", () => {
  const blocks = workBlocksFromProgressRows([
    {
      id: "tool-one",
      kind: "ran_command",
      state: "delivered",
      safe_label: "Bash: pwd",
      safe_tool_name: "Bash",
      safe_input_label: "pwd",
      tool_call_id: "tool-one",
      work_block_id: "work-todo-inspect",
      work_block_label: "프로젝트 메타정보와 구조 확인 중",
      work_decision_summary: "현재 디렉터리를 확인합니다.",
    },
    {
      id: "tool-two",
      kind: "read",
      state: "delivered",
      safe_label: "Read artifact-1",
      safe_tool_name: "Read Tool Output",
      safe_input_label: "artifact-1",
      tool_call_id: "tool-two",
      work_block_id: "work-todo-inspect",
      work_block_label: "프로젝트 메타정보와 구조 확인 중",
      work_decision_summary: "압축된 출력을 읽습니다.",
    },
  ]);

  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toMatchObject({
    id: "work-todo-inspect",
    label: "프로젝트 메타정보와 구조 확인 중",
  });
  expect(blocks[0]?.rows).toHaveLength(2);
  expect(blocks[0]?.rows[0]).toMatchObject({
    safe_label: "Bash: pwd",
    safe_tool_name: "Bash",
    safe_input_label: "pwd",
  });
  expect(blocks[0]?.rows[0]?.work_block_label).toBeUndefined();
  expect(blocks[0]?.rows[0]?.work_decision_summary).toBeUndefined();
});

test("work blocks keep repeated authored decisions with different explicit ids separate", () => {
  const decision = {
    work_decision_summary:
      "전체 테스트 exit code가 실패로 확인됐으니, 저장된 요약 파일에서 실패 라인만 검색 도구로 직접 추출하겠습니다.",
    work_decision_rationale:
      "실패 테스트명을 먼저 확인해야 불필요한 수정 범위를 줄일 수 있습니다.",
    work_decision_next_step:
      "실패 테스트명을 확인한 뒤 해당 테스트만 단독 실행해 수정하겠습니다.",
    work_decision_source: "assistant-authored",
  };
  const rows = [
    {
      id: "public-note-failure",
      kind: "message",
      state: "running",
      safe_label:
        "전체 테스트 exit code가 실패로 확인됐으니, 저장된 요약 파일에서 실패 라인만 검색 도구로 직접 추출하겠습니다.\n실패 테스트명을 확인한 뒤 해당 테스트만 단독 실행해 수정하겠습니다.",
      work_block_id: "public-note-failure",
      work_block_label: "검증 실패 지점을 좁히는 중",
      ...decision,
    },
    ...["read-ledger", "grep-failure", "run-single-test"].map((id, index) => ({
      id,
      kind: index === 0 ? "read" : index === 1 ? "searched" : "ran_command",
      state: "running",
      safe_label:
        index === 0
          ? "Read Project Ledger"
          : index === 1
            ? "Search failure lines"
            : "Bash: bun test sandy-decision-single-test",
      safe_tool_name:
        index === 0 ? "Read" : index === 1 ? "Search" : "Bash",
      safe_input_label:
        index === 0
          ? "Project Ledger"
          : index === 1
            ? "failure lines"
            : "bun test sandy-decision-single-test",
      tool_call_id: `tool-${id}`,
      work_block_id: `work-${id}`,
      work_block_label: "검증 실패 지점을 좁히는 중",
      ...decision,
    })),
  ];

  const blocks = workBlocksFromProgressRows(rows);

  expect(blocks).toHaveLength(4);
  expect(blocks.map((block) => block.id)).toEqual([
    "public-note-failure",
    "work-read-ledger",
    "work-grep-failure",
    "work-run-single-test",
  ]);
  expect(blocks.map((block) => block.label)).toEqual([
    "검증 실패 지점을 좁히는 중",
    "검증 실패 지점을 좁히는 중",
    "검증 실패 지점을 좁히는 중",
    "검증 실패 지점을 좁히는 중",
  ]);
  expect(blocks[0]?.decision_summary)
    .toBe("전체 테스트 exit code가 실패로 확인됐으니, 저장된 요약 파일에서 실패 라인만 검색 도구로 직접 추출하겠습니다.");
  expect(blocks.map((block) => block.rows.map((row) => row.safe_tool_name))).toEqual([
    [undefined],
    ["Read"],
    ["Search"],
    ["Bash"],
  ]);
});

test("tool controls use their own input label instead of decision summary", () => {
  const blocks = workBlocksFromProgressRows([
    {
      id: "tool-sandy",
      kind: "ran_command",
      state: "running",
      safe_label: "Bash: sandbox/run-checks.sh",
      safe_tool_name: "Bash",
      safe_input_label: "sandbox/run-checks.sh",
      tool_call_id: "tool-sandy-run",
      work_block_id: "work-sandy",
      work_block_label: "Sandy bot를 통한 실행 검증",
      work_decision_summary: "Sandy bot 실행 검증 요약",
      work_decision_source: "assistant-authored",
    },
    {
      id: "work-sandy",
      kind: "work_block",
      state: "running",
      safe_label: "Sandy bot 검증",
      work_block_id: "work-sandy",
      work_block_label: "Sandy bot를 통한 실행 검증",
      work_decision_summary: "Sandy bot 실행 검증 요약",
      work_decision_source: "assistant-authored",
    },
  ]);

  expect(blocks).toHaveLength(1);
  const toolRow = blocks[0]?.rows[0];
  expect(toolRow).toMatchObject({
    safe_tool_name: "Bash",
    safe_input_label: "sandbox/run-checks.sh",
    safe_label: "Bash: sandbox/run-checks.sh",
  });
  expect(toolRow?.work_decision_summary).toBeUndefined();
  expect(toolRow?.safe_tool_name).toBe("Bash");
  expect(toolRow?.safe_input_label).toBe("sandbox/run-checks.sh");
});

test("tool row safe input labels do not inherit decision summary from missing input", () => {
  const blocks = workBlocksFromProgressRows([
    {
      id: "work-sandy-2",
      kind: "work_block",
      state: "running",
      safe_label: "Sandy bot를 통한 실행 검증",
      work_block_id: "work-sandy-2",
      work_block_label: "Sandy bot를 통한 실행 검증",
      work_decision_summary: "Sandy bot 실행 검증 요약",
      work_decision_source: "assistant-authored",
    },
    {
      id: "tool-sandy-2",
      kind: "ran_command",
      state: "running",
      safe_label: "Bash",
      safe_tool_name: "Bash",
      tool_call_id: "tool-sandy-run-2",
      work_block_id: "work-sandy-2",
      work_block_label: "Sandy bot를 통한 실행 검증",
      work_decision_summary: "Sandy bot 실행 검증 요약",
      work_decision_source: "assistant-authored",
    },
  ]);

  expect(blocks).toHaveLength(1);
  const block = blocks[0];
  expect(block).toMatchObject({
    id: "work-sandy-2",
    label: "Sandy bot를 통한 실행 검증",
    decision_summary: "Sandy bot 실행 검증 요약",
  });
  expect(block?.rows).toHaveLength(1);
  const toolRow = block?.rows[0];
  expect(toolRow?.safe_input_label).toBeUndefined();
  expect(toolRow?.safe_label).toBe("Bash");
  expect(toolRow?.work_decision_summary).toBeUndefined();
  expect(toolRow?.safe_tool_name).toBe("Bash");
  expect(JSON.stringify(toolRow)).not.toContain("Sandy bot 실행 검증 요약");
});

test("work blocks do not synthesize missing workBlockLabel from safe labels", () => {
  const blocks = workBlocksFromProgressRows([
    {
      id: "work-without-label",
      kind: "work_block",
      state: "running",
      safe_label: "Runtime fallback label",
      work_block_id: "work-without-label",
    },
    {
      id: "tool-without-work-label",
      kind: "ran_command",
      state: "running",
      safe_label: "Bash: npm test",
      safe_tool_name: "Bash",
      safe_input_label: "npm test",
      tool_call_id: "tool-without-work-label",
      work_block_id: "work-without-label",
    },
  ]);

  expect(blocks).toEqual([]);
  expect(JSON.stringify(blocks)).not.toContain("Runtime fallback label");
});

test("work blocks do not project public message rows as tool activity", () => {
  const blocks = workBlocksFromProgressRows([
    {
      id: "public-note",
      kind: "message",
      state: "running",
      safe_label:
        "요청하신 공개 출처 확인과 CSV 생성 단계를 먼저 잡겠습니다.",
      work_block_id: "work-dispatch",
    },
    {
      id: "dispatch-row",
      kind: "dispatch",
      state: "delivered",
      safe_label: "Dispatch: 공개 출처 확인과 CSV 생성",
      safe_tool_name: "Dispatch",
      safe_input_label: "공개 출처 확인과 CSV 생성",
      work_block_id: "work-dispatch",
      work_block_label: "공개 출처 확인과 CSV 생성 중",
    },
  ]);

  expect(blocks).toEqual([]);
  expect(JSON.stringify(blocks)).not.toContain("Dispatch:");
});

test("work blocks still keep real dispatch tool evidence", () => {
  const blocks = workBlocksFromProgressRows([
    {
      id: "dispatch-worker-row",
      kind: "dispatch",
      state: "delivered",
      safe_label: "Dispatch: worker review",
      safe_tool_name: "Dispatch",
      safe_input_label: "worker review",
      tool_call_id: "tool-dispatch-worker",
      work_block_id: "work-dispatch-worker",
      work_block_label: "검토 작업을 맡기는 중",
    },
  ]);

  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toMatchObject({
    id: "work-dispatch-worker",
    label: "검토 작업을 맡기는 중",
  });
  expect(blocks[0]?.rows[0]).toMatchObject({
    safe_tool_name: "Dispatch",
    safe_input_label: "worker review",
    tool_call_id: "tool-dispatch-worker",
  });
});

test("typed UI read models keep runtime faults separate from progress rows", () => {
  const models = typedUiReadModelsFromProgressRows([
    {
      id: "fault-row",
      kind: "runtime_fault",
      state: "runtime_fault",
      safe_label: "Runtime interrupted.",
      runtime_fault_id: "fault-1",
      runtime_fault_kind: "provider_stream_corruption",
      runtime_fault_retryable: true,
      runtime_fault_public_summary: "Runtime interrupted.",
      runtime_fault_safe_error_code: "runtime_fault",
    },
    {
      id: "tool-row",
      kind: "ran_command",
      state: "failed",
      safe_label: "Bash: npm test",
      safe_tool_name: "Bash",
      safe_input_label: "npm test",
      work_decision_summary: "Decision text must not label the tool.",
      work_decision_source: "assistant-authored",
    },
  ]);

  expect(models).toEqual([
    {
      type: "runtime_fault",
      faultId: "fault-1",
      kind: "provider_stream_corruption",
      retryable: true,
      publicSummary: "Runtime interrupted.",
      safeErrorCode: "runtime_fault",
      safeCause: undefined,
    },
    {
      type: "tool_control",
      toolName: "Bash",
      inputLabel: "npm test",
      label: "Bash: npm test",
      toolCallId: undefined,
      workBlockId: undefined,
    },
  ]);
});

test("typed UI acknowledged receipt projects as status without decision or work block fallback", () => {
  const models = typedUiReadModelsFromProgressRows([
    {
      id: "ack-row",
      kind: "turn",
      state: "accepted",
      safe_label: "Request received. Preparing the work.",
      receipt_kind: "turn.acknowledged",
      work_block_id: "work-ack",
      work_block_label: "This must not become a work block.",
      public_decision_summary: "This must not become a decision.",
      public_decision_source: "assistant-authored",
    },
  ]);

  expect(models).toEqual([
    {
      type: "receipt",
      label: "Request received. Preparing the work.",
      state: "accepted",
      receiptKind: "turn.acknowledged",
    },
  ]);
});

test("typed UI opening assistant decision does not become a work block or tool control", () => {
  const models = typedUiReadModelsFromProgressRows([
    {
      id: "opening-decision",
      kind: "decision",
      state: "running",
      safe_label: "I will inspect the current app-client readmodel contract.",
      safe_tool_name: "Bash",
      safe_input_label: "bun test",
      tool_call_id: "tool-leak",
      work_block_id: "work-leak",
      work_block_label: "This must not become a work block.",
      public_decision_role: "opening",
      public_decision_summary:
        "I will inspect the current app-client readmodel contract.",
      public_decision_rationale:
        "The UI must render opening decisions from explicit public decisions.",
      public_decision_next_step: "Patch only the client readmodel helpers.",
      public_decision_source: "model-authored",
      public_decision_evidence_refs: ["turn.acknowledged"],
    },
  ]);

  expect(models).toEqual([
    {
      type: "decision",
      summary: "I will inspect the current app-client readmodel contract.",
      rationale:
        "The UI must render opening decisions from explicit public decisions.",
      nextStep: "Patch only the client readmodel helpers.",
      source: "model-authored",
      evidenceRefs: ["turn.acknowledged"],
    },
  ]);
});

test("typed UI tool controls use safe tool labels when rows carry opening decision text", () => {
  const openingText =
    "I will inspect the current app-client readmodel contract.";
  const models = typedUiReadModelsFromProgressRows([
    {
      id: "tool-row",
      kind: "ran_command",
      state: "running",
      safe_label: openingText,
      safe_tool_name: "Bash",
      safe_input_label: "bun test tests/unit/app-client-utils.test.ts",
      tool_call_id: "tool-test",
      work_block_id: "work-test",
      work_block_label: "Run app-client utils tests",
      work_decision_summary: openingText,
      work_decision_source: "assistant-authored",
      public_decision_role: "opening",
      public_decision_summary: openingText,
      public_decision_source: "model-authored",
    },
  ]);

  expect(models).toEqual([
    {
      type: "tool_control",
      toolName: "Bash",
      inputLabel: "bun test tests/unit/app-client-utils.test.ts",
      label: "Bash: bun test tests/unit/app-client-utils.test.ts",
      toolCallId: "tool-test",
      workBlockId: "work-test",
    },
  ]);
  expect(JSON.stringify(models)).not.toContain(openingText);
});

test("work blocks ignore opening decisions and acknowledged receipt rows", () => {
  const blocks = workBlocksFromProgressRows([
    {
      id: "ack-row",
      kind: "turn",
      state: "accepted",
      safe_label: "Request received. Preparing the work.",
      receipt_kind: "turn.acknowledged",
      work_block_id: "work-ack",
      work_block_label: "Receipt text must not become a block.",
    },
    {
      id: "opening-decision",
      kind: "decision",
      state: "running",
      safe_label: "I will inspect the current app-client readmodel contract.",
      work_block_id: "work-opening",
      work_block_label: "Opening text must not become a block.",
      public_decision_role: "opening",
      public_decision_summary:
        "I will inspect the current app-client readmodel contract.",
      public_decision_source: "model-authored",
    },
  ]);

  expect(blocks).toEqual([]);
  expect(JSON.stringify(blocks)).not.toContain("Request received");
  expect(JSON.stringify(blocks)).not.toContain("app-client readmodel");
});

test("retry eligibility requires runtime fault message code", () => {
  expect(
    isRuntimeFaultRetryableMessage({
      retryable: true,
      safe_error_code: "runtime_fault",
    }),
  ).toBe(true);
  expect(
    isRuntimeFaultRetryableMessage({
      retryable: true,
      safe_error_code: "tool_invalid_arguments",
    }),
  ).toBe(false);
  expect(isRuntimeFaultRetryableMessage({ retryable: true })).toBe(false);
  expect(
    isRuntimeFaultRetryableMessage({
      retryable: false,
      safe_error_code: "runtime_fault",
    }),
  ).toBe(false);
});

test("production work block projection keeps mixed tool row decisions out of block semantics", () => {
  const blocks = workBlocksFromProgressRows([
    {
      id: "mixed-tool-row",
      kind: "ran_command",
      state: "delivered",
      safe_label: "Bash: bun test",
      safe_tool_name: "Bash",
      safe_input_label: "bun test",
      tool_call_id: "tool-mixed",
      work_block_id: "work-mixed",
      work_block_label: "테스트 실행 중",
      work_decision_summary: "This decision must not become the work block decision.",
      work_decision_rationale: "Tool compatibility rows are not decision rows.",
      work_decision_next_step: "Keep rendering this as a tool row.",
      work_decision_source: "assistant-authored",
    },
  ]);

  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toMatchObject({
    id: "work-mixed",
    label: "테스트 실행 중",
    rows: [
      expect.objectContaining({
        id: "mixed-tool-row",
        safe_tool_name: "Bash",
        safe_input_label: "bun test",
      }),
    ],
  });
  expect(blocks[0]?.decision_summary).toBeUndefined();
  expect(blocks[0]?.rows[0]?.work_decision_summary).toBeUndefined();
});

test("timeline applies first visible progress turn events as legacy status rows", () => {
  let messages: MessageRecord[] = [];
  let currentSummary: SessionSummaryView | null = {
    session_id: "general",
    turn_state: "thinking",
    latest_progress: {
      turn_id: "turn-1",
      safe_progress_rows: [],
    },
  };

  applyTimelineEvents(
    [
      {
        id: 1,
        type: "agent.turn_event",
        payload: {
          session_id: "general",
          turn_id: "turn-1",
          event: {
            id: "event-first-progress",
            sessionId: "general",
            turnId: "turn-1",
            sessionSequence: 1,
            turnSequence: 1,
            kind: "turn.first_progress",
            visibility: "public",
            payload: {
              note: "필요한 맥락을 확인하겠습니다.",
              workBlockId: "first-progress-note",
              workBlockLabel: "필요한 맥락을 확인하겠습니다.",
            },
          },
        },
      },
    ] satisfies TimelineEvent[],
    "general",
    (update) => {
      messages = update(messages);
    },
    (update) => {
      currentSummary = update(currentSummary);
      return currentSummary;
    },
  );

  expect(currentSummary?.latest_progress?.safe_progress_rows).toContainEqual(
    expect.objectContaining({
      id: "event-first-progress",
      kind: "turn",
      state: "thinking",
      safe_label: "필요한 맥락을 확인하겠습니다.",
    }),
  );
  const row = currentSummary?.latest_progress?.safe_progress_rows?.find(
    (item) => item.id === "event-first-progress",
  );
  expect(row?.work_block_id).toBeUndefined();
  expect(row?.work_block_label).toBeUndefined();
  expect(row?.work_decision_summary).toBeUndefined();
  expect(messages).toEqual([]);
});

test("timeline applies turn acknowledgements as accepted progress rows", () => {
  let messages: MessageRecord[] = [];
  let currentSummary: SessionSummaryView | null = {
    session_id: "general",
    turn_state: "thinking",
    latest_progress: {
      turn_id: "turn-ack",
      safe_progress_rows: [],
    },
  };

  applyTimelineEvents(
    [
      {
        id: 1,
        type: "agent.turn_event",
        payload: {
          session_id: "general",
          turn_id: "turn-ack",
          event: {
            id: "event-ack",
            sessionId: "general",
            turnId: "turn-ack",
            sessionSequence: 1,
            turnSequence: 1,
            kind: "turn.acknowledged",
            visibility: "public",
            payload: {
              safeLabel: "Request received. Preparing the work.",
              transport: "app",
            },
          },
        },
      },
    ] satisfies TimelineEvent[],
    "general",
    (update) => {
      messages = update(messages);
    },
    (update) => {
      currentSummary = update(currentSummary);
      return currentSummary;
    },
  );

  expect(currentSummary?.latest_progress?.safe_progress_rows).toContainEqual(
    expect.objectContaining({
      id: "event-ack",
      kind: "turn",
      state: "accepted",
      safe_label: "Request received. Preparing the work.",
    }),
  );
  expect(messages).toEqual([]);
});

test("first visible progress status rows do not render as standalone active work blocks", () => {
  const blocks = workBlocksFromProgressRows([
    {
      id: "event-first-progress",
      kind: "turn",
      state: "thinking",
      safe_label: "필요한 맥락을 확인하겠습니다.",
    },
  ]);

  expect(blocks).toEqual([]);
});

test("client and shared first-progress projections stay status-only", () => {
  const event = createAgentTurnEvent({
    id: "event-first-progress-shared",
    sessionId: "general",
    turnId: "turn-1",
    sessionSequence: 1,
    turnSequence: 1,
    kind: "turn.first_progress",
    visibility: "public",
    payload: {
      note: "필요한 맥락을 확인하겠습니다.",
      workBlockId: "first-progress-note",
      workBlockLabel: "필요한 맥락을 확인하겠습니다.",
      decisionSummary: "This must not project as a decision.",
      decisionSource: "assistant-authored",
    },
  });
  const sharedRow = sharedProgressRowFromTurnEvent(event);
  let messages: MessageRecord[] = [];
  let currentSummary: SessionSummaryView | null = {
    session_id: "general",
    turn_state: "thinking",
    latest_progress: {
      turn_id: "turn-1",
      safe_progress_rows: [],
    },
  };

  applyTimelineEvents(
    [
      {
        id: 1,
        type: "agent.turn_event",
        payload: {
          session_id: "general",
          turn_id: "turn-1",
          event,
        },
      },
    ] satisfies TimelineEvent[],
    "general",
    (update) => {
      messages = update(messages);
    },
    (update) => {
      currentSummary = update(currentSummary);
      return currentSummary;
    },
  );

  const clientRow = currentSummary?.latest_progress?.safe_progress_rows?.find(
    (item) => item.id === event.id,
  );
  if (!sharedRow) {
    throw new Error("shared first-progress projection must produce a row");
  }
  expect(clientRow).toEqual(sharedRow);
  expect(clientRow).toMatchObject({
    kind: "turn",
    state: "thinking",
    safe_label: "필요한 맥락을 확인하겠습니다.",
  });
  expect(clientRow?.work_block_id).toBeUndefined();
  expect(clientRow?.work_block_label).toBeUndefined();
  expect(clientRow?.work_decision_summary).toBeUndefined();
  expect(messages).toEqual([]);
});

test("work block projection keeps decision message rows separate from later explicit tool blocks", () => {
  const decision = {
    work_decision_summary: "저장된 targeted test 로그 파일을 직접 읽겠습니다.",
    work_decision_rationale: "실패 출력이 압축되어 로그 파일을 읽어야 합니다.",
    work_decision_next_step: "실패 블록 기준으로 parser repair를 최소 패치하겠습니다.",
    work_decision_source: "assistant-authored",
  };
  const blocks = workBlocksFromProgressRows([
    {
      id: "event-decision-message",
      kind: "message",
      state: "running",
      safe_label:
        "저장된 targeted test 로그 파일을 직접 읽겠습니다.\n실패 블록 기준으로 parser repair를 최소 패치하겠습니다.",
      work_block_id: "public-note-decision",
      work_block_label:
        "저장된 targeted test 로그 파일을 직접 읽겠습니다.\n실패 블록 기준으로 parser repair를 최소 패치하겠습니다.",
      ...decision,
    },
    {
      id: "event-tool-read",
      kind: "read",
      state: "running",
      safe_label: "Read: sandy-decision-targeted.log",
      safe_tool_name: "Read",
      safe_input_label: "sandy-decision-targeted.log",
      tool_call_id: "tool-read",
      work_block_id: "work-todo-decision-judge-closeout",
      work_block_label: "Decision Judge 변경분을 검증하고 실패를 고쳐 커밋하는 중",
      ...decision,
    },
  ]);

  expect(blocks).toHaveLength(2);
  expect(blocks[0]).toMatchObject({
    id: "public-note-decision",
    label:
      "저장된 targeted test 로그 파일을 직접 읽겠습니다.\n실패 블록 기준으로 parser repair를 최소 패치하겠습니다.",
    decision_summary: "저장된 targeted test 로그 파일을 직접 읽겠습니다.",
    rows: [
      expect.objectContaining({
        id: "event-decision-message",
        kind: "message",
      }),
    ],
  });
  expect(blocks[1]).toMatchObject({
    id: "work-todo-decision-judge-closeout",
    label: "Decision Judge 변경분을 검증하고 실패를 고쳐 커밋하는 중",
    decision_summary: undefined,
    rows: [
      expect.objectContaining({
        id: "event-tool-read",
        kind: "read",
        safe_tool_name: "Read",
      }),
    ],
  });
});

test("first visible progress stays scoped through failure and ignores other sessions", () => {
  let messages: MessageRecord[] = [];
  let currentSummary: SessionSummaryView | null = {
    session_id: "general",
    turn_state: "thinking",
    latest_progress: {
      turn_id: "turn-first",
      safe_progress_rows: [],
    },
  };

  applyTimelineEvents(
    [
      {
        id: 1,
        type: "agent.turn_event.progress",
        payload: {
          session_id: "general",
          turn_id: "turn-first",
          row: {
            id: "row-first-progress",
            kind: "turn",
            state: "thinking",
            safe_label: "필요한 맥락을 확인하겠습니다.",
          },
        },
      },
      {
        id: 2,
        type: "agent.turn_event",
        payload: {
          session_id: "other-session",
          turn_id: "turn-other",
          event: {
            id: "event-other-first-progress",
            sessionId: "other-session",
            turnId: "turn-other",
            sessionSequence: 1,
            turnSequence: 1,
            kind: "turn.first_progress",
            visibility: "public",
            payload: {
              note: "다른 세션 진행입니다.",
              workBlockId: "other-work",
              workBlockLabel: "다른 세션 진행입니다.",
            },
          },
        },
      },
      {
        id: 3,
        type: "turn.state_changed",
        payload: {
          session_id: "general",
          turn_id: "turn-first",
          state: "failed",
          safe_status_label: "Failed",
        },
      },
      {
        id: 4,
        type: "agent.turn_event",
        payload: {
          session_id: "general",
          turn_id: "turn-first",
          event: {
            id: "event-turn-failed",
            sessionId: "general",
            turnId: "turn-first",
            sessionSequence: 2,
            turnSequence: 2,
            kind: "turn.failed",
            visibility: "public",
            payload: { safeLabel: "Provider unavailable" },
          },
        },
      },
    ] satisfies TimelineEvent[],
    "general",
    (update) => {
      messages = update(messages);
    },
    (update) => {
      currentSummary = update(currentSummary);
      return currentSummary;
    },
  );

  expect(currentSummary?.latest_progress?.turn_id).toBe("turn-first");
  expect(currentSummary?.latest_progress?.state).toBe("failed");
  expect(currentSummary?.latest_progress?.safe_progress_rows).toContainEqual(
    expect.objectContaining({
      id: "row-first-progress",
      safe_label: "필요한 맥락을 확인하겠습니다.",
      kind: "turn",
      state: "thinking",
    }),
  );
  const row = currentSummary?.latest_progress?.safe_progress_rows?.find(
    (item) => item.id === "row-first-progress",
  );
  expect(row?.work_block_id).toBeUndefined();
  expect(row?.work_block_label).toBeUndefined();
  expect(JSON.stringify(currentSummary)).not.toContain("다른 세션 진행입니다.");
  expect(messages).toEqual([]);
});

test("timeline keeps todo compatibility progress as semantic todo rows", () => {
  let messages: MessageRecord[] = [];
  let currentSummary: SessionSummaryView | null = {
    session_id: "general",
    turn_state: "working",
    latest_progress: {
      turn_id: "turn-workstream",
      safe_progress_rows: [],
    },
  };

  applyTimelineEvents(
    [
      {
        id: 1,
        type: "agent.turn_event",
        payload: {
          event: {
            id: "event-todo-progress",
            sessionId: "general",
            turnId: "turn-workstream",
            sessionSequence: 1,
            turnSequence: 1,
            kind: "tool.progress",
            visibility: "public",
            createdAt: "2026-05-15T00:00:00.000Z",
            payload: {
              activityKind: "todo",
              state: "delivered",
              safeLabel: "Report WorkStream E2E validation result",
              detailRows: [
                {
                  id: "phase",
                  kind: "phase",
                  safe_label: "Phase",
                  safe_value: "Reporting",
                  state: "delivered",
                },
              ],
            },
          },
        },
      },
    ],
    "general",
    (update) => {
      messages = update(messages);
    },
    (update) => {
      currentSummary = update(currentSummary);
      return currentSummary;
    },
  );

  const row = currentSummary?.latest_progress?.safe_progress_rows[0];
  expect(row).toMatchObject({
    kind: "todo",
    safe_label: "Report WorkStream E2E validation result",
  });
  expect(row?.safe_tool_name).toBeUndefined();
  expect(messages).toEqual([]);
});

test("turn progress snapshots are capped for long active sessions", () => {
  let snapshots: Record<string, TurnProgressSnapshot> = {};
  for (let index = 0; index < 85; index += 1) {
    snapshots = mergeTurnProgressFromSummary(snapshots, {
      latest_progress: {
        turn_id: `turn-${index}`,
        updated_at: `2026-05-07T00:${String(index).padStart(2, "0")}:00.000Z`,
        safe_progress_rows: [
          {
            id: `row-${index}`,
            state: "delivered",
            safe_label: `Turn ${index}`,
          },
        ],
      },
    });
  }

  expect(Object.keys(snapshots)).toHaveLength(80);
  expect(snapshots["turn-0"]).toBeUndefined();
  expect(snapshots["turn-4"]).toBeUndefined();
  expect(snapshots["turn-5"]).toBeDefined();
  expect(snapshots["turn-84"]).toBeDefined();
});

test("single-turn work history keeps all work rows instead of a latest-N slice", () => {
  const rows = Array.from({ length: 40 }, (_, index) => ({
    id: `work-${index}`,
    kind: "work_block",
    state: "delivered",
    safe_label: `작업 단계 ${index + 1}`,
    work_block_id: `work-block-${index}`,
    work_block_label: `작업 단계 ${index + 1}`,
  }));

  const snapshots = mergeTurnProgressFromSummary(
    {},
    {
      session_id: "session-a",
      turn_state: "delivered",
      latest_progress: {
        turn_id: "turn-long-work",
        state: "delivered",
        safe_progress_rows: rows,
      },
    },
  );
  const blocks = workBlocksFromProgressRows(
    snapshots["turn-long-work"]?.safe_progress_rows ?? [],
  );

  expect(snapshots["turn-long-work"]?.safe_progress_rows).toHaveLength(40);
  expect(blocks).toHaveLength(40);
  expect(blocks[0]?.label).toBe("작업 단계 1");
  expect(blocks.at(-1)?.label).toBe("작업 단계 40");
});

test("timeline terminal tool events replace legacy running summary rows", () => {
  let messages: MessageRecord[] = [];
  let currentSummary: SessionSummaryView | null = {
    session_id: "general",
    turn_state: "thinking",
    latest_progress: {
      turn_id: "turn-merge",
      safe_progress_rows: [
        {
          id: "legacy-running",
          kind: "ran_command",
          state: "running",
          safe_label: "Checking Project Ledger status",
          safe_tool_name: "Project Ledger",
          safe_input_label: "status",
        },
      ],
    },
  };

  applyTimelineEvents(
    [
      {
        id: 2,
        type: "agent.turn_event.progress",
        payload: {
          session_id: "general",
          turn_id: "turn-merge",
          row: {
            id: "tool-completed",
            kind: "ran_command",
            state: "delivered",
            safe_label: "Checking Project Ledger status",
            safe_tool_name: "Project Ledger",
            safe_input_label: "status",
            tool_call_id: "tool-status",
            work_block_id: "work-status",
          },
        },
      },
    ] satisfies TimelineEvent[],
    "general",
    (update) => {
      messages = update(messages);
    },
    (update) => {
      currentSummary = update(currentSummary);
      return currentSummary;
    },
  );

  const projectLedgerRows =
    currentSummary?.latest_progress?.safe_progress_rows.filter(
      (row) => row.safe_label === "Checking Project Ledger status",
    ) ?? [];
  expect(projectLedgerRows).toHaveLength(1);
  expect(projectLedgerRows[0]?.state).toBe("delivered");
  expect(messages).toEqual([]);
});

test("timeline terminal tool events absorb late legacy running rows", () => {
  let messages: MessageRecord[] = [];
  let currentSummary: SessionSummaryView | null = {
    session_id: "general",
    turn_state: "delivered",
    latest_progress: {
      turn_id: "turn-merge",
      safe_progress_rows: [
        {
          id: "tool-completed",
          kind: "ran_command",
          state: "delivered",
          safe_label: "Checking Project Ledger status",
          safe_tool_name: "Project Ledger",
          safe_input_label: "status",
          tool_call_id: "tool-status",
          work_block_id: "work-status",
        },
      ],
    },
  };

  applyTimelineEvents(
    [
      {
        id: 3,
        type: "agent.turn_event.progress",
        payload: {
          session_id: "general",
          turn_id: "turn-merge",
          row: {
            id: "legacy-running-late",
            kind: "ran_command",
            state: "running",
            safe_label: "Checking Project Ledger status",
            safe_tool_name: "Project Ledger",
            safe_input_label: "status",
          },
        },
      },
    ] satisfies TimelineEvent[],
    "general",
    (update) => {
      messages = update(messages);
    },
    (update) => {
      currentSummary = update(currentSummary);
      return currentSummary;
    },
  );

  const projectLedgerRows =
    currentSummary?.latest_progress?.safe_progress_rows.filter(
      (row) => row.safe_label === "Checking Project Ledger status",
    ) ?? [];
  expect(projectLedgerRows).toHaveLength(1);
  expect(projectLedgerRows[0]).toMatchObject({
    state: "delivered",
    safe_tool_name: "Project Ledger",
    safe_input_label: "status",
    tool_call_id: "tool-status",
  });
  expect(messages).toEqual([]);
});

test("timeline keeps same-label progress rows separate when detail evidence conflicts", () => {
  let messages: MessageRecord[] = [];
  let currentSummary: SessionSummaryView | null = {
    session_id: "general",
    turn_state: "delivered",
    latest_progress: {
      turn_id: "turn-conflict",
      safe_progress_rows: [
        {
          id: "tool-completed-a",
          kind: "ran_command",
          state: "delivered",
          safe_label: "Checking Project Ledger status",
          safe_tool_name: "Project Ledger",
          safe_input_label: "status",
          tool_call_id: "tool-status-a",
          work_block_id: "work-status-a",
          safe_detail_rows: [
            {
              id: "project-ledger-workspace",
              kind: "workspace",
              safe_label: "Workspace",
              safe_value: "~/project-a",
              state: "delivered",
            },
          ],
        },
      ],
    },
  };

  applyTimelineEvents(
    [
      {
        id: 4,
        type: "agent.turn_event.progress",
        payload: {
          session_id: "general",
          turn_id: "turn-conflict",
          row: {
            id: "legacy-running-b",
            kind: "ran_command",
            state: "running",
            safe_label: "Checking Project Ledger status",
            safe_tool_name: "Project Ledger",
            safe_input_label: "status",
            safe_detail_rows: [
              {
                id: "project-ledger-workspace",
                kind: "workspace",
                safe_label: "Workspace",
                safe_value: "~/project-b",
                state: "running",
              },
            ],
          },
        },
      },
    ] satisfies TimelineEvent[],
    "general",
    (update) => {
      messages = update(messages);
    },
    (update) => {
      currentSummary = update(currentSummary);
      return currentSummary;
    },
  );

  const projectLedgerRows =
    currentSummary?.latest_progress?.safe_progress_rows.filter(
      (row) => row.safe_label === "Checking Project Ledger status",
    ) ?? [];
  expect(projectLedgerRows).toHaveLength(2);
  expect(projectLedgerRows.map((row) => row.state).sort()).toEqual([
    "delivered",
    "running",
  ]);
  expect(messages).toEqual([]);
});

test("timeline keeps same-label progress rows separate when path evidence conflicts", () => {
  let messages: MessageRecord[] = [];
  let currentSummary: SessionSummaryView | null = {
    session_id: "general",
    turn_state: "delivered",
    latest_progress: {
      turn_id: "turn-path-conflict",
      safe_progress_rows: [
        {
          id: "tool-completed-a",
          kind: "edited",
          state: "delivered",
          safe_label: "Writing project file",
          safe_tool_name: "File",
          safe_input_label: "write",
          tool_call_id: "tool-write-a",
          safe_path_labels: ["~/project-a/game.js"],
        },
      ],
    },
  };

  applyTimelineEvents(
    [
      {
        id: 5,
        type: "agent.turn_event.progress",
        payload: {
          session_id: "general",
          turn_id: "turn-path-conflict",
          row: {
            id: "legacy-running-b",
            kind: "edited",
            state: "running",
            safe_label: "Writing project file",
            safe_tool_name: "File",
            safe_input_label: "write",
            safe_path_labels: ["~/project-b/game.js"],
          },
        },
      },
    ] satisfies TimelineEvent[],
    "general",
    (update) => {
      messages = update(messages);
    },
    (update) => {
      currentSummary = update(currentSummary);
      return currentSummary;
    },
  );

  const fileRows =
    currentSummary?.latest_progress?.safe_progress_rows.filter(
      (row) => row.safe_label === "Writing project file",
    ) ?? [];
  expect(fileRows).toHaveLength(2);
  expect(fileRows.map((row) => row.state).sort()).toEqual([
    "delivered",
    "running",
  ]);
  expect(messages).toEqual([]);
});

test("timeline keeps repeated identical tool calls separate when tool ids differ", () => {
  let messages: MessageRecord[] = [];
  let currentSummary: SessionSummaryView | null = {
    session_id: "general",
    turn_state: "thinking",
    latest_progress: {
      turn_id: "turn-repeat",
      safe_progress_rows: [],
    },
  };

  applyTimelineEvents(
    [
      progressEventWithTool(1, "turn-repeat", "Bash: ls", "tool-1"),
      progressEventWithTool(2, "turn-repeat", "Bash: ls", "tool-2"),
    ] satisfies TimelineEvent[],
    "general",
    (update) => {
      messages = update(messages);
    },
    (update) => {
      currentSummary = update(currentSummary);
      return currentSummary;
    },
  );

  const labels =
    currentSummary?.latest_progress?.safe_progress_rows.map(
      (row) => row.safe_label,
    ) ?? [];
  expect(labels).toEqual(["Bash: ls", "Bash: ls"]);
  expect(messages).toEqual([]);
});

test("timeline lets later delivered state replace earlier failed state for the same tool", () => {
  let messages: MessageRecord[] = [];
  let currentSummary: SessionSummaryView | null = {
    session_id: "general",
    turn_state: "thinking",
    latest_progress: {
      turn_id: "turn-retry",
      safe_progress_rows: [],
    },
  };

  applyTimelineEvents(
    [
      progressEventWithTool(
        1,
        "turn-retry",
        "Bash: bun test",
        "tool-retry",
        "failed",
      ),
      progressEventWithTool(
        2,
        "turn-retry",
        "Bash: bun test",
        "tool-retry",
        "delivered",
      ),
    ] satisfies TimelineEvent[],
    "general",
    (update) => {
      messages = update(messages);
    },
    (update) => {
      currentSummary = update(currentSummary);
      return currentSummary;
    },
  );

  const rows = currentSummary?.latest_progress?.safe_progress_rows ?? [];
  expect(rows).toHaveLength(1);
  expect(rows[0]?.state).toBe("delivered");
  expect(messages).toEqual([]);
});

test("timeline keeps terminal progress state when a later running row arrives", () => {
  let messages: MessageRecord[] = [];
  let currentSummary: SessionSummaryView | null = {
    session_id: "general",
    turn_state: "delivered",
    latest_progress: {
      turn_id: "turn-terminal",
      safe_progress_rows: [
        {
          id: "tool-complete",
          kind: "ran_command",
          state: "complete",
          safe_label: "Bash: bun test",
          safe_tool_name: "Bash",
          safe_input_label: "bun test",
          tool_call_id: "tool-test",
        },
      ],
    },
  };

  applyTimelineEvents(
    [
      progressEventWithTool(
        6,
        "turn-terminal",
        "Bash: bun test",
        "tool-test",
        "running",
      ),
    ] satisfies TimelineEvent[],
    "general",
    (update) => {
      messages = update(messages);
    },
    (update) => {
      currentSummary = update(currentSummary);
      return currentSummary;
    },
  );

  expect(currentSummary?.latest_progress?.safe_progress_rows).toContainEqual(
    expect.objectContaining({
      safe_label: "Bash: bun test",
      state: "complete",
      tool_call_id: "tool-test",
    }),
  );
  expect(messages).toEqual([]);
});

test("timeline replay does not regress cached terminal turn progress snapshots", () => {
  let messages: MessageRecord[] = [];
  let turnProgress: Record<string, TurnProgressSnapshot> = {
    "turn-terminal": {
      turn_id: "turn-terminal",
      state: "delivered",
      summary: "Done",
      safe_progress_rows: [
        {
          id: "tool-complete",
          kind: "ran_command",
          state: "delivered",
          safe_label: "Bash: bun test",
          safe_tool_name: "Bash",
          safe_input_label: "bun test",
          tool_call_id: "tool-test",
        },
      ],
    },
  };

  applyTimelineEvents(
    [
      progressEventWithTool(
        6,
        "turn-terminal",
        "Bash: bun test",
        "tool-test",
        "running",
      ),
    ] satisfies TimelineEvent[],
    "general",
    (update) => {
      messages = update(messages);
    },
    undefined,
    (update) => {
      turnProgress = update(turnProgress);
      return turnProgress;
    },
  );

  expect(turnProgress["turn-terminal"]?.state).toBe("delivered");
  expect(turnProgress["turn-terminal"]?.summary).toBe("Done");
  expect(turnProgress["turn-terminal"]?.safe_progress_rows[0]?.state).toBe(
    "delivered",
  );
  expect(messages).toEqual([]);
});

test("completed turn activity hides status-only lifecycle rows", () => {
  const rows = completedTurnActivityRows([
    {
      id: "previous-turn-status",
      kind: "turn",
      state: "delivered",
      safe_label: "Delivered",
    },
    {
      id: "guard-completed",
      kind: "system",
      state: "delivered",
      safe_label: "Response checked",
    },
    {
      id: "final-started",
      kind: "message",
      state: "running",
      safe_label: "Preparing final answer",
    },
    {
      id: "web-search-completed",
      kind: "searched",
      state: "delivered",
      safe_label: "Web search: 2026년 5월 6일 충주 날씨 예보",
      safe_tool_name: "Web search",
      safe_input_label: "2026년 5월 6일 충주 날씨 예보",
    },
    {
      id: "public-note",
      kind: "message",
      state: "running",
      safe_label: "Checking local forecast sources",
    },
  ]);

  expect(rows.map((row) => row.id)).toEqual([
    "web-search-completed",
    "public-note",
  ]);
});

test("work blocks group contextual objectives with nested toolchain rows", () => {
  const blocks = workBlocksFromProgressRows([
    {
      id: "block-start",
      kind: "work_block",
      state: "running",
      safe_label: "Checking local Project Ledger status",
      work_block_id: "work-status",
      work_block_label: "Checking local Project Ledger status",
      work_decision_summary: "Checking local Project Ledger status",
      work_decision_rationale:
        "The dashboard update should start from the canonical local ledger state.",
      work_decision_next_step:
        "Use this status to decide which ledger view to refresh.",
      work_decision_source: "assistant-authored",
      work_decision_evidence_refs: ["Project Ledger status"],
    },
    {
      id: "tool-start",
      kind: "read",
      state: "running",
      safe_label: "Checking local Project Ledger status",
      safe_tool_name: "Project Ledger",
      safe_input_label: "status",
      tool_call_id: "tool-status",
      work_block_id: "work-status",
      work_block_label: "Checking local Project Ledger status",
    },
    {
      id: "tool-complete",
      kind: "read",
      state: "delivered",
      safe_label: "Checking local Project Ledger status",
      safe_tool_name: "Project Ledger",
      safe_input_label: "status",
      tool_call_id: "tool-status",
      work_block_id: "work-status",
      work_block_label: "Checking local Project Ledger status",
    },
  ]);

  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toMatchObject({
    id: "work-status",
    label: "Checking local Project Ledger status",
    state: "delivered",
    decision_summary: "Checking local Project Ledger status",
    decision_rationale:
      "The dashboard update should start from the canonical local ledger state.",
    decision_next_step:
      "Use this status to decide which ledger view to refresh.",
    decision_source: "assistant-authored",
    decision_evidence_refs: ["Project Ledger status"],
  });
  expect(blocks[0]?.rows).toHaveLength(1);
  expect(blocks[0]?.rows[0]).toMatchObject({
    id: "tool-complete",
    safe_tool_name: "Project Ledger",
    safe_input_label: "status",
  });
});

test("work blocks render runtime-derived intent but ignore non-renderable decision fields", () => {
  const blocks = workBlocksFromProgressRows([
    {
      id: "block-runtime",
      kind: "work_block",
      state: "running",
      safe_label: "Runtime fallback label",
      work_block_id: "work-runtime",
      work_block_label: "Explicit work block label",
      work_decision_summary: "Runtime fallback explains the immediate tool step.",
      work_decision_rationale: "The basic workspace tool can proceed without waiting for another model decision.",
      work_decision_next_step: "Use the tool result to choose the next visible step.",
      work_decision_source: "runtime-derived",
    },
    {
      id: "tool-runtime",
      kind: "read",
      state: "delivered",
      safe_label: "Read local status",
      safe_tool_name: "Read",
      tool_call_id: "tool-runtime",
      work_block_id: "work-runtime",
      work_block_label: "Explicit work block label",
      work_decision_summary: "Tool fallback must not become public context",
      work_decision_source: "review-repaired",
    },
  ]);

  expect(blocks).toEqual([
    expect.objectContaining({
      id: "work-runtime",
      label: "Explicit work block label",
      state: "delivered",
      decision_summary: "Runtime fallback explains the immediate tool step.",
      decision_rationale: "The basic workspace tool can proceed without waiting for another model decision.",
      decision_next_step: "Use the tool result to choose the next visible step.",
      decision_source: "runtime-derived",
    }),
  ]);
});

test("runtime-derived work decisions do not alias separate work block ids", () => {
  const sharedDecision = {
    work_decision_summary: "기본 작업 도구로 확인 가능한 범위를 바로 처리합니다.",
    work_decision_rationale: "별도 모델 판단 없이도 현재 파일을 확인할 수 있습니다.",
    work_decision_next_step: "결과를 바탕으로 다음 단계를 판단합니다.",
    work_decision_source: "runtime-derived",
  };
  const blocks = workBlocksFromProgressRows([
    {
      id: "block-runtime-a",
      kind: "work_block",
      state: "running",
      safe_label: "첫 번째 파일 확인",
      work_block_id: "work-runtime-a",
      work_block_label: "첫 번째 파일 확인",
      ...sharedDecision,
    },
    {
      id: "block-runtime-b",
      kind: "work_block",
      state: "running",
      safe_label: "두 번째 파일 확인",
      work_block_id: "work-runtime-b",
      work_block_label: "두 번째 파일 확인",
      ...sharedDecision,
    },
  ]);

  expect(blocks.map((block) => block.id)).toEqual([
    "work-runtime-a",
    "work-runtime-b",
  ]);
  expect(blocks.map((block) => block.decision_source)).toEqual([
    "runtime-derived",
    "runtime-derived",
  ]);
});

test("authored work decisions keep separate explicit work block ids", () => {
  const sharedDecision = {
    work_decision_summary: "관련 파일을 확인합니다.",
    work_decision_rationale: "같은 조사 흐름이지만 각 도구 묶음은 선형 블록으로 남아야 합니다.",
    work_decision_next_step: "읽은 결과를 바탕으로 다음 블록을 결정합니다.",
    work_decision_source: "assistant-authored",
  };
  const blocks = workBlocksFromProgressRows([
    {
      id: "block-a",
      kind: "work_block",
      state: "running",
      safe_label: "첫 번째 파일 확인",
      work_block_id: "work-authored-a",
      work_block_label: "첫 번째 파일 확인",
      ...sharedDecision,
    },
    {
      id: "block-b",
      kind: "work_block",
      state: "running",
      safe_label: "두 번째 파일 확인",
      work_block_id: "work-authored-b",
      work_block_label: "두 번째 파일 확인",
      ...sharedDecision,
    },
  ]);

  expect(blocks.map((block) => block.id)).toEqual([
    "work-authored-a",
    "work-authored-b",
  ]);
  expect(blocks.map((block) => block.label)).toEqual([
    "첫 번째 파일 확인",
    "두 번째 파일 확인",
  ]);
});

test("work blocks accept every public decision source from the app contract", () => {
  const blocks = workBlocksFromProgressRows([
    {
      id: "block-principal",
      kind: "work_block",
      state: "running",
      safe_label: "Principal decision status",
      work_block_id: "work-principal",
      work_block_label: "사용자 결정에 따라 작업합니다.",
      work_decision_summary: "사용자 지시를 기준으로 작업합니다.",
      work_decision_rationale: "사용자가 명시한 방향이 현재 작업의 권한입니다.",
      work_decision_next_step: "명시된 방향에 맞춰 다음 검증을 실행합니다.",
      work_decision_source: "principal-authored",
    },
    {
      id: "block-model",
      kind: "work_block",
      state: "running",
      safe_label: "Model decision status",
      work_block_id: "work-model",
      work_block_label: "모델 판단에 따라 작업합니다.",
      work_decision_summary: "모델이 선택한 검증 경로를 실행합니다.",
      work_decision_rationale: "관찰된 증거가 추가 검증을 요구합니다.",
      work_decision_next_step: "선택한 검증을 실행하고 결과를 반영합니다.",
      work_decision_source: "model-authored",
    },
  ]);

  expect(blocks.map((block) => block.decision_source)).toEqual([
    "principal-authored",
    "model-authored",
  ]);
  expect(blocks.map((block) => block.decision_summary)).toEqual([
    "사용자 지시를 기준으로 작업합니다.",
    "모델이 선택한 검증 경로를 실행합니다.",
  ]);
});

test("work blocks do not duplicate todo compatibility rows when a work block exists", () => {
  const blocks = workBlocksFromProgressRows([
    {
      id: "todo-running",
      kind: "todo",
      state: "running",
      safe_label: "Checking local Project Ledger status",
      safe_input_label: "decision-status",
    },
    {
      id: "block-start",
      kind: "work_block",
      state: "running",
      safe_label: "Checking local Project Ledger status",
      work_block_id: "work-status",
      work_block_label: "Checking local Project Ledger status",
      work_decision_summary: "Checking local Project Ledger status",
    },
    {
      id: "tool-complete",
      kind: "read",
      state: "delivered",
      safe_label: "Checking local Project Ledger status",
      safe_tool_name: "Project Ledger",
      safe_input_label: "status",
      tool_call_id: "tool-status",
      work_block_id: "work-status",
      work_block_label: "Checking local Project Ledger status",
    },
    {
      id: "todo-delivered",
      kind: "todo",
      state: "delivered",
      safe_label: "Checking local Project Ledger status",
      safe_input_label: "decision-status",
    },
  ]);

  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toMatchObject({
    id: "work-status",
    label: "Checking local Project Ledger status",
  });
  expect(blocks[0]?.rows).toHaveLength(1);
  expect(blocks[0]?.rows[0]?.id).toBe("tool-complete");
});

test("completed work blocks exclude Delivered and keep only process evidence", () => {
  const blocks = completedTurnWorkBlocks([
    {
      id: "delivered",
      kind: "turn",
      state: "delivered",
      safe_label: "Delivered",
    },
    {
      id: "tool-complete",
      kind: "edited",
      state: "delivered",
      safe_label: "Rendering Project Ledger dashboard view",
      safe_tool_name: "Project Ledger",
      safe_input_label: "dashboard view",
      tool_call_id: "tool-dashboard",
      work_block_id: "work-dashboard",
      work_block_label: "Rendering Project Ledger dashboard view",
    },
  ]);

  expect(blocks.map((block) => block.label)).toEqual([
    "Rendering Project Ledger dashboard view",
  ]);
  expect(JSON.stringify(blocks)).not.toContain("Delivered");
});

test("toolchain visibility does not render work block titles as tool buttons", () => {
  const blockLabel = "Inspecting failed validation evidence";
  expect(
    isVisibleToolchainProgressRow(
      {
        id: "block-title-row",
        kind: "model",
        state: "running",
        safe_label: blockLabel,
        safe_tool_name: blockLabel,
      },
      blockLabel,
    ),
  ).toBe(false);
  expect(
    isVisibleToolchainProgressRow(
      {
        id: "real-tool-row",
        kind: "ran_command",
        state: "running",
        safe_label: "Bash: npm test",
        safe_tool_name: "Bash",
        safe_input_label: "npm test",
        tool_call_id: "tool-test",
      },
      blockLabel,
    ),
  ).toBe(true);
});

test("timeline fallback redacts private turn event labels before rendering", () => {
  let messages: MessageRecord[] = [];
  let currentSummary: SessionSummaryView | null = {
    session_id: "general",
    turn_state: "thinking",
    latest_progress: {
      turn_id: "turn-privacy",
      safe_progress_rows: [],
    },
  };
  const encodedPrivate = Buffer.from(
    "<thinking>private plan</thinking>",
    "utf8",
  ).toString("base64");

  applyTimelineEvents(
    [
      publicNoteEvent(
        1,
        "event-secret",
        "Authorization: Bearer private-token DATABASE_URL=postgres://user:pass@host/db",
      ),
      publicNoteEvent(2, "event-private", encodedPrivate),
      publicNoteEvent(
        3,
        "event-thinking",
        "< thinking /> let me think through private notes",
      ),
    ],
    "general",
    (update) => {
      messages = update(messages);
    },
    (update) => {
      currentSummary = update(currentSummary);
      return currentSummary;
    },
  );

  const labels =
    currentSummary?.latest_progress?.safe_progress_rows.map(
      (row) => row.safe_label,
    ) ?? [];
  expect(labels[0]).toContain("[redacted]");
  expect(labels[0]).not.toContain("private-token");
  expect(labels[0]).not.toContain("postgres://");
  expect(labels[1]).toBe("Working");
  expect(labels[2]).toBe("Working");
  expect(messages).toEqual([]);
});

test("timeline keeps late old-turn events out of the current turn activity", () => {
  let messages: MessageRecord[] = [];
  let currentSummary: SessionSummaryView | null = {
    session_id: "general",
    turn_state: "thinking",
    latest_progress: {
      turn_id: "turn-current",
      safe_progress_rows: [],
    },
  };

  applyTimelineEvents(
    [
      progressEvent(1, "turn-old", "Old command"),
      progressEvent(2, "turn-current", "Current command"),
    ],
    "general",
    (update) => {
      messages = update(messages);
    },
    (update) => {
      currentSummary = update(currentSummary);
      return currentSummary;
    },
  );

  const labels =
    currentSummary?.latest_progress?.safe_progress_rows.map(
      (row) => row.safe_label,
    ) ?? [];
  expect(labels).toEqual(["Current command"]);
  expect(currentSummary?.latest_progress?.turn_id).toBe("turn-current");
});

test("timeline ignores stale old-turn events that arrive after current activity", () => {
  let messages: MessageRecord[] = [];
  let currentSummary: SessionSummaryView | null = {
    session_id: "general",
    turn_state: "thinking",
    latest_progress: {
      turn_id: "turn-current",
      safe_progress_rows: [
        {
          id: "existing-current",
          kind: "ran_command",
          state: "running",
          safe_label: "Existing current",
        },
      ],
    },
  };

  applyTimelineEvents(
    [
      progressEvent(1, "turn-current", "Current command"),
      progressEvent(2, "turn-old", "Old command"),
    ],
    "general",
    (update) => {
      messages = update(messages);
    },
    (update) => {
      currentSummary = update(currentSummary);
      return currentSummary;
    },
  );

  const labels =
    currentSummary?.latest_progress?.safe_progress_rows.map(
      (row) => row.safe_label,
    ) ?? [];
  expect(labels).toEqual(["Existing current", "Current command"]);
  expect(currentSummary?.latest_progress?.turn_id).toBe("turn-current");
  expect(messages).toEqual([]);
});

function progressEvent(
  id: number,
  turnId: string,
  label: string,
): TimelineEvent {
  return {
    id,
    type: "agent.turn_event.progress",
    payload: {
      session_id: "general",
      turn_id: turnId,
      row: {
        id: `row-${turnId}`,
        kind: "ran_command",
        state: "running",
        safe_label: label,
      },
    },
  };
}

function progressEventWithTool(
  id: number,
  turnId: string,
  label: string,
  toolCallId: string,
  state = "running",
): TimelineEvent {
  return {
    id,
    type: "agent.turn_event.progress",
    payload: {
      session_id: "general",
      turn_id: turnId,
      row: {
        id: `row-${toolCallId}-${id}`,
        kind: "ran_command",
        state,
        safe_label: label,
        safe_tool_name: "Bash",
        safe_input_label: label.replace(/^Bash:\s*/u, ""),
        tool_call_id: toolCallId,
      },
    },
  };
}

function publicNoteEvent(
  id: number,
  eventId: string,
  note: string,
): TimelineEvent {
  return {
    id,
    type: "agent.turn_event",
    payload: {
      session_id: "general",
      turn_id: "turn-privacy",
      event: {
        id: eventId,
        sessionId: "general",
        turnId: "turn-privacy",
        sessionSequence: id,
        turnSequence: id,
        kind: "assistant.public_note",
        visibility: "public",
        payload: { note },
      },
    },
  };
}

function message(
  id: string,
  role: "user" | "assistant",
  cursor: number,
  turnId: string,
): MessageRecord {
  return {
    id,
    chat_id: "session-a",
    turn_id: turnId,
    role,
    text: id,
    status: "delivered",
    retryable: false,
    cursor,
  };
}

function worker(
  phase: WorkerActivitySummary["phase"],
  terminal: boolean,
  updatedAt: string,
  override: Partial<WorkerActivitySummary> = {},
): WorkerActivitySummary {
  return {
    worker_id: `worker-${phase}`,
    activity_kind: "worker",
    worker_label: "Worker 1",
    objective: "조사",
    phase,
    status_line: phase,
    terminal,
    updated_at: updatedAt,
    supported_controls: [],
    ...override,
  };
}
