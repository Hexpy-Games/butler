import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentConversationStore } from
  "../../packages/butler-agent/src/agent/conversation/store.ts";
import {
  BUTLER_TOOLS,
  createButlerToolExecutor,
} from "../../packages/butler-agent/src/agent/tools/butler-tools.ts";
import {
  listConversationSessions,
  readConversationSession,
} from
  "../../packages/butler-agent/src/agent/context/conversation-session-reference.ts";

let root = "";
let appDbPath = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "butler-session-reference-"));
  appDbPath = join(root, "app.sqlite");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("session discovery defaults to the active project and enriches canonical sessions with App titles", () => {
  const store = new AgentConversationStore({ butlerData: root });
  try {
    seedSession(store, {
      sessionId: "cs_current",
      externalSessionId: "chat-current",
      projectId: "project-butler",
      user: "현재 세션 질문",
      assistant: "현재 세션 답변",
      now: "2026-08-06T01:00:00.000Z",
    });
    seedSession(store, {
      sessionId: "cs_sandy",
      externalSessionId: "chat-sandy",
      projectId: "project-butler",
      user: "샌디봇 최근 작업을 확인해줘",
      assistant: "SSH 상태와 배포 결과를 확인했습니다.",
      now: "2026-08-06T02:00:00.000Z",
    });
    seedSession(store, {
      sessionId: "cs_other",
      externalSessionId: "chat-other",
      projectId: "project-other",
      user: "다른 프로젝트 대화",
      assistant: "다른 프로젝트 답변",
      now: "2026-08-06T03:00:00.000Z",
    });
  } finally {
    store.close();
  }
  seedAppCatalog(appDbPath, [
    ["chat-current", "현재 대화", "project-butler", "cs_current"],
    ["chat-sandy", "샌디봇 세션", "project-butler", "cs_sandy"],
    ["chat-other", "외부 프로젝트", "project-other", "cs_other"],
  ]);

  const result = listConversationSessions({
    butlerData: root,
    appMessageDbPath: appDbPath,
    currentSessionId: "cs_current",
    limit: 10,
  });

  expect(result.ok).toBe(true);
  expect(result.scope).toEqual({ kind: "current_project", project_id: "project-butler" });
  expect(result.sessions.map((session) => session.conversation_session_id))
    .toEqual(["cs_sandy", "cs_current"]);
  expect(result.sessions[0]).toMatchObject({
    title: "샌디봇 세션",
    catalog_source: "app-catalog-compat",
    external_session_id: "chat-sandy",
    project_id: "project-butler",
    message_count: 2,
  });
  expect(result.sessions[0]?.recent_messages.map((message) => message.text)).toEqual([
    "샌디봇 최근 작업을 확인해줘",
    "SSH 상태와 배포 결과를 확인했습니다.",
  ]);
});

test("all-session discovery can find another project but project-scoped reading rejects it", () => {
  const store = new AgentConversationStore({ butlerData: root });
  try {
    seedSession(store, {
      sessionId: "cs_current",
      externalSessionId: "chat-current",
      projectId: "project-butler",
      user: "현재",
      assistant: "현재 답변",
      now: "2026-08-06T01:00:00.000Z",
    });
    seedSession(store, {
      sessionId: "cs_other",
      externalSessionId: "chat-other",
      projectId: "project-sandy",
      user: "샌디 프로젝트 최근 대화",
      assistant: "샌디 배포는 완료됐습니다.",
      now: "2026-08-06T02:00:00.000Z",
    });
  } finally {
    store.close();
  }

  const listed = listConversationSessions({
    butlerData: root,
    currentSessionId: "cs_current",
    projectId: "project-butler",
    scope: "all_sessions",
  });
  expect(listed.sessions.map((session) => session.conversation_session_id))
    .toEqual(["cs_other", "cs_current"]);

  const rejected = readConversationSession({
    butlerData: root,
    currentSessionId: "cs_current",
    conversationSessionId: "cs_other",
    projectId: "project-butler",
    scope: "current_project",
  });
  expect(rejected).toEqual({
    ok: false,
    code: "conversation_session_scope_mismatch",
    conversation_session_id: "cs_other",
    scope: { kind: "current_project", project_id: "project-butler" },
  });

  const read = readConversationSession({
    butlerData: root,
    currentSessionId: "cs_current",
    conversationSessionId: "cs_other",
    projectId: "project-butler",
    scope: "all_sessions",
    limit: 2,
  });
  expect(read.ok).toBe(true);
  if (!read.ok) throw new Error("expected canonical conversation read");
  expect(read.session_id).toBe("cs_other");
  expect(read.runtime_session_id).toBe("cs_other");
  expect(read.messages.map((message) => message.text)).toEqual([
    "샌디 프로젝트 최근 대화",
    "샌디 배포는 완료됐습니다.",
  ]);
});

test("cross-session reading rejects unknown canonical ids", () => {
  const result = readConversationSession({
    butlerData: root,
    currentSessionId: "cs_current",
    conversationSessionId: "cs_missing",
    scope: "all_sessions",
  });

  expect(result).toEqual({
    ok: false,
    code: "conversation_session_not_found",
    conversation_session_id: "cs_missing",
    scope: { kind: "all_sessions", project_id: null },
  });
});

test("native session-reference tools expose bounded schemas and execute the canonical path", async () => {
  const listTool = BUTLER_TOOLS.find((tool) => tool.name === "list_conversation_sessions");
  const readTool = BUTLER_TOOLS.find((tool) => tool.name === "read_conversation_session");
  expect(listTool?.parameters.required).toEqual([]);
  expect(Object.keys(listTool?.parameters.properties ?? {})).toEqual([
    "scope",
    "limit",
    "include_archived",
    "preview_messages",
  ]);
  expect(readTool?.parameters.required).toEqual(["conversation_session_id"]);
  expect(Object.keys(readTool?.parameters.properties ?? {})).toEqual([
    "conversation_session_id",
    "scope",
    "anchor_message_id",
    "direction",
    "limit",
    "max_chars",
    "include_tools",
  ]);

  const store = new AgentConversationStore({ butlerData: root });
  try {
    seedSession(store, {
      sessionId: "cs_current",
      externalSessionId: "chat-current",
      projectId: "project-butler",
      user: "현재 대화",
      assistant: "현재 답변",
      now: "2026-08-06T01:00:00.000Z",
    });
    seedSession(store, {
      sessionId: "cs_target",
      externalSessionId: "chat-target",
      projectId: "project-butler",
      user: "참조할 대화",
      assistant: "참조할 답변",
      now: "2026-08-06T02:00:00.000Z",
    });
  } finally {
    store.close();
  }
  const execute = createButlerToolExecutor({
    butlerHome: root,
    butlerData: root,
    appMessageDbPath: appDbPath,
    sessionId: "cs_current",
    projectId: "project-butler",
  });

  const listed = await execute({
    name: "list_conversation_sessions",
    args: {},
    rawArguments: "{}",
  }) as ReturnType<typeof listConversationSessions>;
  expect(listed.sessions.map((session) => session.conversation_session_id))
    .toEqual(["cs_target", "cs_current"]);

  const read = await execute({
    name: "read_conversation_session",
    args: { conversation_session_id: "cs_target" },
    rawArguments: JSON.stringify({ conversation_session_id: "cs_target" }),
  }) as ReturnType<typeof readConversationSession>;
  expect(read.ok).toBe(true);
  if (!read.ok) throw new Error("expected native canonical conversation read");
  expect(read.messages.map((message) => message.text)).toEqual([
    "참조할 대화",
    "참조할 답변",
  ]);
});

function seedSession(
  store: AgentConversationStore,
  input: {
    sessionId: string;
    externalSessionId: string;
    projectId: string;
    user: string;
    assistant: string;
    now: string;
  },
): void {
  const turn = store.beginTurn({
    gateway: "app",
    externalSessionId: input.externalSessionId,
    sessionId: input.sessionId,
    projectId: input.projectId,
    actor: "user",
    now: input.now,
  });
  store.appendUserMessage({
    sessionId: input.sessionId,
    turnId: turn.id,
    text: input.user,
    now: input.now,
  });
  store.appendAssistantMessage({
    sessionId: input.sessionId,
    turnId: turn.id,
    text: input.assistant,
    now: input.now,
  });
  store.finalizeTurn({ turnId: turn.id, completedAt: input.now });
}

function seedAppCatalog(
  dbPath: string,
  rows: Array<[string, string, string, string]>,
): void {
  const db = new Database(dbPath, { create: true });
  try {
    db.exec(`
      CREATE TABLE chats (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        project_id TEXT,
        conversation_session_id TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    const insert = db.query(`
      INSERT INTO chats (
        id, title, kind, project_id, conversation_session_id,
        archived, created_at, updated_at
      ) VALUES (?, ?, 'project', ?, ?, 0, ?, ?)
    `);
    for (const [id, title, projectId, conversationSessionId] of rows) {
      insert.run(
        id,
        title,
        projectId,
        conversationSessionId,
        "2026-08-06T00:00:00.000Z",
        "2026-08-06T00:00:00.000Z",
      );
    }
  } finally {
    db.close();
  }
}
