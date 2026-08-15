import { expect, test } from "bun:test";
import {
  mergeMessageListViews,
  messageListCursor,
  messageListSyncCursor,
  snapshotForCache,
} from "../../packages/butler-app/client/ui/src/app/messageCache.ts";
import type { MessageListView } from "../../packages/butler-app/client/ui/src/app/types.ts";

test("message cache snapshots keep completed messages and skip pending rows", () => {
  const snapshot = snapshotForCache("session-a", {
    chat_id: "session-a",
    messages: [
      message("user-a", "user", 1, "turn-a"),
      message("assistant-a", "assistant", 2, "turn-a"),
      {
        ...message("assistant-pending", "assistant", 3, "turn-b"),
        status: "pending",
      },
    ],
    turn_progress: {
      "turn-a": {
        turn_id: "turn-a",
        state: "delivered",
        safe_progress_rows: [
          {
            id: "row-a",
            kind: "ran_command",
            state: "delivered",
            safe_label: "Bash: first",
            safe_tool_name: "Bash",
            safe_input_label: "first",
            work_block_id: "work-first",
            work_block_label: "첫 작업 실행 중",
          },
        ],
      },
      "turn-b": {
        turn_id: "turn-b",
        state: "running",
        safe_progress_rows: [
          {
            id: "row-b",
            kind: "ran_command",
            state: "running",
            safe_label: "Bash: pending",
          },
        ],
      },
    },
  });

  expect(snapshot?.messages.map((item) => item.id)).toEqual([
    "user-a",
    "assistant-a",
  ]);
  expect(snapshot?.messages[1]?.work_blocks?.[0]?.rows[0]?.safe_label).toBe(
    "Bash: first",
  );
  expect(snapshot?.next_cursor).toBe(2);
  expect(Object.keys(snapshot?.turn_progress ?? {})).toEqual(["turn-a"]);
});

test("message cache preserves terminal canonical Work Ledger states", () => {
  const states = ["completed", "stopped", "planned"];
  const snapshot = snapshotForCache("session-work", {
    chat_id: "session-work",
    messages: [message("assistant-work", "assistant", 3, "turn-work")],
    turn_progress: {
      "turn-work": {
        turn_id: "turn-work",
        state: "delivered",
        safe_progress_rows: states.map((state, index) => ({
          id: `task-${index + 1}`,
          kind: "todo",
          state,
          safe_label: `Task ${index + 1}`,
          safe_input_label: `task-${index + 1}`,
          bridge_phase: "btcc_work_ledger",
        })),
      },
    },
  });

  expect(
    snapshot?.turn_progress?.["turn-work"]?.safe_progress_rows.map((row) => row.state),
  ).toEqual(states);
});

test("message cache merge appends server rows from the cached final cursor", () => {
  const cached: MessageListView = {
    chat_id: "session-a",
    messages: [
      message("user-a", "user", 1, "turn-a"),
      message("assistant-a", "assistant", 2, "turn-a"),
    ],
    turn_progress: {
      "turn-a": {
        turn_id: "turn-a",
        state: "delivered",
        safe_progress_rows: [],
      },
    },
    next_cursor: 2,
  };
  const incoming: MessageListView = {
    chat_id: "session-a",
    messages: [
      message("user-b", "user", 3, "turn-b"),
      message("assistant-b", "assistant", 4, "turn-b"),
    ],
    turn_progress: {
      "turn-b": {
        turn_id: "turn-b",
        state: "delivered",
        safe_progress_rows: [],
      },
    },
    next_cursor: 4,
  };

  const merged = mergeMessageListViews(cached, incoming);

  expect(messageListCursor(cached)).toBe(2);
  expect(merged.messages.map((item) => item.id)).toEqual([
    "user-a",
    "assistant-a",
    "user-b",
    "assistant-b",
  ]);
  expect(Object.keys(merged.turn_progress ?? {}).sort()).toEqual([
    "turn-a",
    "turn-b",
  ]);
  expect(merged.next_cursor).toBe(4);
});

test("message cache merge keeps unchanged cached row identities", () => {
  const cachedMessage = message("assistant-a", "assistant", 2, "turn-a");
  const cachedProgress = {
    turn_id: "turn-a",
    state: "delivered",
    safe_progress_rows: [
      {
        id: "row-a",
        kind: "ran_command",
        state: "delivered",
        safe_label: "Bash: cached",
        safe_tool_name: "Bash",
        safe_input_label: "cached",
        work_block_id: "work-cached",
        work_block_label: "캐시된 작업 실행 중",
      },
    ],
  };
  const [frozenMessage] = snapshotForCache("session-a", {
    chat_id: "session-a",
    messages: [cachedMessage],
    turn_progress: { "turn-a": cachedProgress },
    next_cursor: 2,
  })!.messages;
  const cached: MessageListView = {
    chat_id: "session-a",
    messages: [frozenMessage!],
    turn_progress: { "turn-a": cachedProgress },
    next_cursor: 2,
  };

  const merged = mergeMessageListViews(cached, {
    chat_id: "session-a",
    messages: [{ ...cachedMessage }],
    turn_progress: {
      "turn-a": {
        ...cachedProgress,
        safe_progress_rows: [...cachedProgress.safe_progress_rows],
      },
    },
    next_cursor: 2,
  });

  expect(merged).toBe(cached);
  expect(merged.messages[0]).toBe(frozenMessage);
  expect(merged.turn_progress?.["turn-a"]).toBe(cachedProgress);
  expect(merged.messages[0]?.work_blocks?.[0]?.rows[0]?.safe_label).toBe(
    "Bash: cached",
  );
});

test("message cache merge refreshes an opaque cursor at the same row", () => {
  const cachedMessage = message("assistant-a", "assistant", 2, "turn-a");
  const cached: MessageListView = {
    chat_id: "session-a",
    messages: [cachedMessage],
    turn_progress: {},
    next_cursor: 2,
    next_cursor_token: "expiring-token",
  };

  const merged = mergeMessageListViews(cached, {
    chat_id: "session-a",
    messages: [{ ...cachedMessage }],
    turn_progress: {},
    next_cursor: 2,
    next_cursor_token: "refreshed-token",
  });

  expect(merged.next_cursor_token).toBe("refreshed-token");
});

test("message cache paints cached messages even when assistant turn progress is incomplete", () => {
  const complete: MessageListView = {
    chat_id: "session-a",
    messages: [
      message("user-a", "user", 1, "turn-a"),
      message("assistant-a", "assistant", 2, "turn-a"),
    ],
    turn_progress: {
      "turn-a": {
        turn_id: "turn-a",
        state: "delivered",
        safe_progress_rows: [],
      },
    },
    next_cursor: 2,
  };
  const incomplete: MessageListView = {
    ...complete,
    turn_progress: {},
  };

  expect(messageListSyncCursor(complete)).toBe(2);
  expect(messageListSyncCursor(incomplete)).toBe(2);
});

test("web fallback message cache hydrates localStorage once and then reads memory", async () => {
  const items = new Map<string, string>();
  const cached = {
    schema: "butler.message-cache.v1",
    chat_id: "session-a",
    cached_at: "2026-05-05T00:00:00.000Z",
    messages: [message("assistant-a", "assistant", 2, "turn-a")],
    turn_progress: {},
    next_cursor: 2,
  };
  items.set("butler:message-cache:v1:session-a", JSON.stringify(cached));
  const previousStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      get length() {
        return items.size;
      },
      key: (index: number) => [...items.keys()][index] ?? null,
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => {
        items.set(key, value);
      },
    },
  });
  const fresh = await import(
    `../../packages/butler-app/client/ui/src/app/messageCache.ts?memory=${Date.now()}`,
  );
  items.clear();

  const view = await fresh.readCachedMessageList("session-a");

  expect(view?.messages[0]?.id).toBe("assistant-a");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: previousStorage,
  });
});

test("electron bridge writes also keep the renderer sync cache warm", async () => {
  const items = new Map<string, string>();
  const bridgeWrites: unknown[] = [];
  const previousStorage = globalThis.localStorage;
  const previousWindow = (globalThis as typeof globalThis & { window?: unknown })
    .window;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      get length() {
        return items.size;
      },
      key: (index: number) => [...items.keys()][index] ?? null,
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => {
        items.set(key, value);
      },
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      butlerApp: {
        writeCachedMessages: async ({ snapshot }: { snapshot: unknown }) => {
          bridgeWrites.push(snapshot);
          return { ok: true };
        },
      },
    },
  });
  const fresh = await import(
    `../../packages/butler-app/client/ui/src/app/messageCache.ts?bridge=${Date.now()}`,
  );

  await fresh.writeCachedMessageList("session-a", {
    chat_id: "session-a",
    messages: [message("assistant-a", "assistant", 2, "turn-a")],
    turn_progress: {},
    next_cursor: 2,
  });

  expect(fresh.readCachedMessageListSync("session-a")?.messages[0]?.id).toBe(
    "assistant-a",
  );
  expect(bridgeWrites).toHaveLength(1);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: previousStorage,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: previousWindow,
  });
});

function message(
  id: string,
  role: "user" | "assistant",
  cursor: number,
  turnId: string,
) {
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
