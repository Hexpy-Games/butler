import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentConversationStore } from "../../packages/butler-agent/src/agent/conversation/store.ts";
import {
  BUTLER_TOOLS,
  createButlerToolExecutor,
} from "../../packages/butler-agent/src/agent/tools/butler-tools.ts";
import {
  listConversationSessions,
  listConversationSessionsV2,
  readConversationSession,
} from "../../packages/butler-agent/src/agent/context/conversation-session-reference.ts";
import { queryMemoryV2 } from "../../packages/butler-agent/src/agent/cognition/memory/exact-query.ts";
import { toolResultToMessage } from "../../packages/butler-agent/src/agent/btcc/agent-loop/tool-result-message.ts";
import { createToolResultModelPreviewContext } from "../../packages/butler-agent/src/agent/tools/tool-result-serialization.ts";
import {
  executePreparedBtccToolCall,
  prepareBtccToolCall,
} from "../../packages/butler-agent/src/agent/btcc/agent-loop/tool-execution.ts";

let root = "";
let appDbPath = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "butler-session-reference-"));
  appDbPath = join(root, "app.sqlite");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("session discovery uses Agent conversation facts without reading App titles", () => {
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
    currentSessionId: "cs_current",
    limit: 10,
  });

  expect(result.ok).toBe(true);
  expect(result.scope).toEqual({
    kind: "current_project",
    project_id: "project-butler",
  });
  expect(
    result.sessions.map((session) => session.conversation_session_id),
  ).toEqual(["cs_sandy", "cs_current"]);
  expect(result.sessions[0]).toMatchObject({
    title: null,
    catalog_source: null,
    external_session_id: "chat-sandy",
    project_id: "project-butler",
    message_count: 2,
  });
  expect(
    result.sessions[0]?.recent_messages.map((message) => message.text),
  ).toEqual([
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
  expect(
    listed.sessions.map((session) => session.conversation_session_id),
  ).toEqual(["cs_other", "cs_current"]);

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

test("v2 session discovery keeps canonical rows when App catalog labels conflict", () => {
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
  } finally {
    store.close();
  }
  seedAppCatalog(appDbPath, [
    ["chat-a", "제목 A", "project-butler", "cs_current"],
    ["chat-b", "제목 B", "project-butler", "cs_current"],
  ]);

  const result = listConversationSessionsV2({
    butlerData: root,
    currentSessionId: "cs_current",
    currentProjectId: "project-butler",
    scope: "current_project",
  });

  expect(result).toMatchObject({
    ok: true,
    diagnostics: ["catalog_conflict"],
    sessions: [{
      conversation_session_id: "cs_current",
      title: null,
      catalog_source: null,
      session_kind: "unknown",
    }],
  });
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
  const listTool = BUTLER_TOOLS.find(
    (tool) => tool.name === "list_conversation_sessions",
  );
  const readTool = BUTLER_TOOLS.find(
    (tool) => tool.name === "read_conversation_session",
  );
  expect(listTool?.parameters.required).toEqual([]);
  expect(
    (listTool as { toolContractVersion?: number } | undefined)
      ?.toolContractVersion,
  ).toBe(2);
  expect(Object.keys(listTool?.parameters.properties ?? {})).toEqual([
    "scope",
    "limit",
    "include_archived",
    "preview_messages",
    "session_ids",
    "project_filter",
    "project_ids",
    "include_internal",
    "session_kind",
    "time",
    "cursor",
  ]);
  expect(readTool?.parameters.required).toEqual([]);
  expect(
    (readTool as { toolContractVersion?: number } | undefined)
      ?.toolContractVersion,
  ).toBe(2);
  expect(Object.keys(readTool?.parameters.properties ?? {})).toEqual([
    "conversation_session_id",
    "scope",
    "session_ids",
    "project_filter",
    "project_ids",
    "include_internal",
    "source_ref",
    "anchor_message_id",
    "direction",
    "limit",
    "max_chars",
    "include_tools",
    "cursor",
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
    sessionId: "cs_current",
    turnId: "turn-current",
    turnContext: "이전 대화를 찾아줘",
    projectId: "project-butler",
  });

  const listed = (await execute({
    name: "list_conversation_sessions",
    args: {},
    rawArguments: "{}",
  })) as ReturnType<typeof listConversationSessions>;
  expect(
    listed.sessions.map((session) => session.conversation_session_id),
  ).toEqual(["cs_target", "cs_current"]);

  const read = (await execute({
    name: "read_conversation_session",
    args: { conversation_session_id: "cs_target" },
    rawArguments: JSON.stringify({ conversation_session_id: "cs_target" }),
  })) as ReturnType<typeof readConversationSession>;
  expect(read.ok).toBe(true);
  if (!read.ok) throw new Error("expected native canonical conversation read");
  expect(read.messages.map((message) => message.text)).toEqual([
    "참조할 대화",
    "참조할 답변",
  ]);
});

test("query source read_args page the complete canonical scalar without changing bytes", async () => {
  const text = `${"가나다🙂".repeat(1_500)}끝`;
  const store = new AgentConversationStore({ butlerData: root });
  const turn = store.beginTurn({
    gateway: "test",
    externalSessionId: "source",
    sessionId: "cs_source",
    actor: "user",
  });
  store.appendUserMessage({
    sessionId: "cs_source",
    turnId: turn.id,
    messageId: "cm_source",
    text,
    originKind: "user_input",
  });
  store.close();
  const execute = createButlerToolExecutor({
    butlerHome: root,
    butlerData: root,
    sessionId: "source",
    turnId: turn.id,
    turnContext: "가나다",
  });
  const native = async (name: "query_memory" | "read_conversation_session", args: Record<string, unknown>) => {
    const tool = BUTLER_TOOLS.find((item) => item.name === name);
    if (!tool) throw new Error(`missing ${name} definition`);
    const prepared = prepareBtccToolCall({ tools: [tool] }, {
      id: `native-${name}`,
      name,
      arguments: args,
      rawArguments: JSON.stringify(args),
    });
    expect(prepared.validationError).toBeNull();
    return executePreparedBtccToolCall({
      executeTool: (call) => execute({
        name: call.name,
        args: call.arguments,
        rawArguments: call.rawArguments,
        ...(call.toolContractVersion === undefined
          ? {} : { toolContractVersion: call.toolContractVersion }),
        ...(call.signal ? { signal: call.signal } : {}),
      }),
    }, prepared);
  };
  const queryResult = await native("query_memory", {
    query: "가나다", scope: "all_user_sessions", limit: 1,
  });
  expect(queryResult.ok).toBe(true);
  const query = queryResult.output as ReturnType<typeof queryMemoryV2>;
  if (!query.ok) throw new Error("expected source query");
  const readArgs = query.results[0]!.read_args;
  let cursor: string | undefined;
  let joined = "";
  do {
    const pageResult = await native("read_conversation_session", {
      ...readArgs, ...(cursor ? { cursor } : {}),
    });
    expect(pageResult.ok).toBe(true);
    const page = pageResult.output as ReturnType<typeof readConversationSession>;
    if (!page.ok || !("mode" in page) || page.mode !== "source") {
      throw new Error("expected source page");
    }
    const sourcePage = page as unknown as {
      text: string;
      next_cursor: string | null;
    };
    const serialized = toolResultToMessage({
      result: {
        name: "read_conversation_session",
        toolCallId: "source-page",
        ok: true,
        output: page,
      },
      modelPreviewContext: createToolResultModelPreviewContext(),
    });
    expect(Buffer.byteLength(serialized.content, "utf8")).toBeLessThanOrEqual(
      24 * 1024,
    );
    expect(JSON.parse(serialized.content).output).toMatchObject(page);
    joined += sourcePage.text;
    cursor = sourcePage.next_cursor ?? undefined;
  } while (cursor);
  expect(Buffer.from(joined, "utf8")).toEqual(Buffer.from(text, "utf8"));

  const allMessages = await native("query_memory", {
    scope: "all_user_sessions", limit: 10,
  });
  expect(allMessages.ok).toBe(true);
  const allOutput = allMessages.output as ReturnType<typeof queryMemoryV2>;
  if (!allOutput.ok) throw new Error("expected omitted query/terms scan");
  expect(allOutput.results.length).toBe(1);
  const anyTerms = await native("query_memory", {
    terms: ["가나다", "없는 말"], match_mode: "any", scope: "all_user_sessions",
  });
  expect(anyTerms.ok).toBe(true);
  const anyOutput = anyTerms.output as ReturnType<typeof queryMemoryV2>;
  if (!anyOutput.ok) throw new Error("expected any terms query");
  expect(anyOutput.results).toHaveLength(1);
  const sessionRead = await native("read_conversation_session", {
    conversation_session_id: "cs_source", scope: "all_user_sessions",
  });
  expect(sessionRead.ok).toBe(true);
  expect(sessionRead.output).toMatchObject({ ok: true });
  expect((await native("query_memory", {
    match_mode: "any", scope: "all_user_sessions",
  })).output).toMatchObject({
    ok: false, code: "invalid_arguments", diagnostics: ["terms_required"],
  });
  expect((await native("query_memory", {
    query: "가나다", terms: ["끝"], match_mode: "any", scope: "all_user_sessions",
  })).output).toMatchObject({
    ok: false, code: "invalid_arguments", diagnostics: ["query_terms_conflict"],
  });
  expect((await native("read_conversation_session", {})).output).toMatchObject({
    ok: false, code: "invalid_arguments", diagnostics: ["source_locator_required"],
  });
  expect((await native("read_conversation_session", {
    ...readArgs, conversation_session_id: "cs_source",
  })).output).toMatchObject({
    ok: false, code: "invalid_arguments", diagnostics: ["source_locator_conflict"],
  });
  expect((await native("read_conversation_session", {
    ...readArgs, limit: 1,
  })).output).toMatchObject({
    ok: false, code: "invalid_arguments", diagnostics: ["source_mode_options_not_allowed"],
  });
  expect((await native("read_conversation_session", {
    conversation_session_id: "cs_source", cursor: "not-a-source-cursor",
  })).output).toMatchObject({
    ok: false, code: "invalid_arguments", diagnostics: ["session_cursor_not_allowed"],
  });
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
    originKind: "user_input",
    now: input.now,
  });
  store.appendAssistantMessage({
    sessionId: input.sessionId,
    turnId: turn.id,
    text: input.assistant,
    originKind: "assistant_public",
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
