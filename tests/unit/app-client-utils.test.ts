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
  workBlocksFromProgressRows,
} from "../../packages/butler-app/client/ui/src/app/utils.ts";
import {
  browserRandomId,
  browserRandomUUID,
} from "../../packages/butler-app/client/ui/src/app/id.ts";
import { resolveMarkdownImageSource } from "../../packages/butler-app/client/ui/src/components/conversation/messageMedia.ts";
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

  expect(frozen?.work_blocks?.[0]?.rows[0]).toBe(
    snapshot.safe_progress_rows[0],
  );
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
      },
    ],
  };
  const [frozen] = freezeMessageWorkBlocks(
    [message("assistant-a", "assistant", 2, "turn-a")],
    { "turn-a": snapshot },
  );

  const refrozen = freezeMessageWorkBlocks([frozen!], {});

  expect(refrozen[0]).toBe(frozen);
  expect(refrozen[0]?.work_blocks?.[0]?.rows[0]).toBe(
    snapshot.safe_progress_rows[0],
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

test("retrying assistant message revives failed turn progress for the same turn", () => {
  const failedRow = {
    id: "row-retry",
    kind: "ran_command",
    state: "failed",
    safe_label: "Bash: previous attempt",
    safe_tool_name: "Bash",
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
        type: "message.updated",
        payload: {
          message: {
            id: "assistant-failed",
            chat_id: "general",
            turn_id: "turn-retry",
            role: "assistant",
            text: "Retrying this turn.",
            status: "retrying",
          },
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
          safe_progress_rows: [failedRow],
        },
      },
      turnProgress: {
        "turn-retry": {
          turn_id: "turn-retry",
          state: "failed",
          safe_progress_rows: [failedRow],
        },
      },
    },
  );

  expect(state.messages[0]?.status).toBe("retrying");
  expect(state.turnProgress["turn-retry"]?.state).toBe("thinking");
  expect(state.turnProgress["turn-retry"]?.safe_progress_rows).toEqual([
    expect.objectContaining({
      id: "row-retry",
      state: "thinking",
      safe_label: "Bash: retry attempt",
    }),
  ]);
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

test("todo composer rows keep ordered steps when compatibility rows duplicate items", async () => {
  const { todoRowsForDisplay } = await import(
    "../../packages/butler-app/client/ui/src/components/conversation/todoComposerRows.ts",
  );
  const rows = todoRowsForDisplay([
    {
      id: "event-review",
      kind: "todo",
      state: "accepted",
      safe_label: "검토",
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

test("todo composer rows collapse duplicate compatibility labels", async () => {
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
});

test("timeline applies first visible progress turn events as public progress rows", () => {
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
      kind: "message",
      safe_label: "필요한 맥락을 확인하겠습니다.",
      work_block_id: "first-progress-note",
      work_block_label: "필요한 맥락을 확인하겠습니다.",
    }),
  );
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

test("first visible progress rows become active work blocks", () => {
  const blocks = workBlocksFromProgressRows([
    {
      id: "event-first-progress",
      kind: "message",
      state: "running",
      safe_label: "필요한 맥락을 확인하겠습니다.",
      work_block_id: "first-progress-note",
      work_block_label: "필요한 맥락을 확인하겠습니다.",
    },
  ]);

  expect(blocks).toEqual([
    expect.objectContaining({
      id: "first-progress-note",
      label: "필요한 맥락을 확인하겠습니다.",
      state: "running",
      rows: [
        expect.objectContaining({
          id: "event-first-progress",
          kind: "message",
          safe_label: "필요한 맥락을 확인하겠습니다.",
        }),
      ],
    }),
  ]);
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
            kind: "message",
            state: "running",
            safe_label: "필요한 맥락을 확인하겠습니다.",
            work_block_id: "first-progress-note",
            work_block_label: "필요한 맥락을 확인하겠습니다.",
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
      work_block_id: "first-progress-note",
    }),
  );
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

test("work blocks ignore unauthorised decision fields when choosing labels and context", () => {
  const blocks = workBlocksFromProgressRows([
    {
      id: "block-runtime",
      kind: "work_block",
      state: "running",
      safe_label: "Runtime fallback label",
      work_block_id: "work-runtime",
      work_decision_summary: "This fallback must not become public context",
      work_decision_rationale: "Runtime-derived repair text is diagnostic only.",
      work_decision_next_step: "Do not render this as a decision.",
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
      work_decision_summary: "Tool fallback must not become public context",
      work_decision_source: "review-repaired",
    },
  ]);

  expect(blocks).toEqual([
    expect.objectContaining({
      id: "work-runtime",
      label: "Runtime fallback label",
      state: "delivered",
      decision_summary: undefined,
      decision_source: undefined,
    }),
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
