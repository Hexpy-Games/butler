import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Page } from "playwright";
import { EMPTY_SETTINGS } from "../../packages/butler-app/client/ui/src/app/constants";
import { HARNESS_MODEL_CATALOG, HARNESS_NAVIGATION } from "../../packages/butler-app/client/ui/src/app/fixtures";
import { onboardingCompletedPatch } from "../../packages/butler-app/client/ui/src/app/onboarding";
import type { MessageRecord, SessionSummary } from "../../packages/butler-app/client/ui/src/app/types";
import { computerFixtures, computersFocusResponse } from "./computers-fixtures";
import { session } from "./initiated-fixtures";
import { appShellRead } from "./offline-app-shell";
import { installSmokeUiAssets } from "./smoke-ui-assets";

export const remoteSessionOrigin = "http://remote-session.localhost";
export const [remoteComputer, unreachableComputer, unconfiguredComputer] = computerFixtures as
  [typeof computerFixtures[number], typeof computerFixtures[number], typeof computerFixtures[number]];
const chatId = "chat-remote";
const turnId = "turn-remote";
const at = "2026-11-24T00:00:00Z";

export async function installRemoteSessionGateway(page: Page, language: "ko" | "en", theme: "light" | "dark") {
  const root = resolve("packages/butler-app/client/ui/dist");
  const navigation = { ...structuredClone(HARNESS_NAVIGATION), chats: [] as SessionSummary[], projects: [],
    space: { revision: 1, groups: [], nodes: [{ key: `s:${chatId}`, kind: "session", entityId: chatId, parentKey: null, position: 0,
      revision: 1, manualPlacement: false, scopeProjectId: null }] } };
  let storedSession: SessionSummary | undefined;
  let messages: MessageRecord[] = [];
  let settings = { ...EMPTY_SETTINGS, ...onboardingCompletedPatch(undefined, at, at),
    language, appearance_theme: theme, collapse_message_box: false, chats_intro_seen: true, model: HARNESS_MODEL_CATALOG.default_model_ref };
  let eventId = 0;
  const fake = {
    computers: false,
    unreachable: false,
    pending: [] as object[],
    sessionReads: 0,
    reconnects: 0,
    createBody: undefined as Record<string, unknown> | undefined,
    decisions: [] as { path: string; body: unknown }[],
    showMemoryFailure() {
      messages = [...messages, {
        id: "remote-answer", chat_id: chatId, turn_id: turnId, role: "assistant", status: "delivered", cursor: 2,
        text: language === "ko" ? "기억 검색을 마치지 못했습니다." : "The memory search did not finish.", created_at: at,
        work_blocks: [{
          id: "memory-work", label: "memory_search", state: "failed",
          rows: [{ id: "memory-output", kind: "used_tool", safe_label: "memory_search", state: "failed", safe_tool_name: "memory_search",
            tool_call_id: "memory-search", tool_result_id: "memory-result" }],
        }],
      }];
    },
    async emit(type: string, payload: Record<string, unknown>) {
      await page.waitForFunction(() => typeof Reflect.get(window, "emitRemoteSessionEvent") === "function");
      await page.evaluate((event) => Reflect.get(window, "emitRemoteSessionEvent")(event), { id: ++eventId, type, payload, created_at: at });
    },
  };

  await page.addInitScript(() => {
    const cacheKey = "butler:app-ui-state:v1";
    if (!localStorage.getItem(cacheKey)) {
      localStorage.setItem(cacheKey, JSON.stringify({ schema: "butler.app-ui-state.v1", cached_at: new Date().toISOString(),
        active_session_id: "draft:chat", left_open: innerWidth >= 768, right_open: false }));
    }
    const streams = new Set<RemoteSessionEvents>();
    class RemoteSessionEvents extends EventTarget {
      onopen?: () => void;
      onmessage?: (event: MessageEvent) => void;
      constructor() {
        super();
        streams.add(this);
        queueMicrotask(() => this.onopen?.());
      }
      close() { streams.delete(this); }
    }
    Reflect.set(window, "EventSource", RemoteSessionEvents);
    Reflect.set(window, "emitRemoteSessionEvent", (event: unknown) => {
      for (const stream of streams) stream.onmessage?.(new MessageEvent("message", { data: JSON.stringify(event) }));
    });
  });

  await page.route(`${remoteSessionOrigin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname: path, searchParams } = url;
    const method = request.method();
    const ok = (data: unknown, status = 200) => route.fulfill({ status, json: { protocol_version: "butler.app.v1", data } });
    if (path === "/") return route.fulfill({ contentType: "text/html", body: readFileSync(join(root, "index.html"), "utf8") });
    if (path === "/computers") return ok({ computers: fake.computers ? [
      remoteComputer, unreachableComputer, { ...unconfiguredComputer, ai_connected: false },
    ] : [], main_model: "key" });
    if (path.startsWith("/computers/") && path.endsWith("/connection")) return ok(computersFocusResponse(path));
    if (path === `/computers/${remoteComputer.id}/reconnect` && method === "POST") {
      fake.reconnects++;
      fake.unreachable = false;
      return ok({ state: "reconnecting", error: null });
    }
    if (path === "/settings") {
      if (method === "PATCH") settings = { ...settings, ...request.postDataJSON() };
      return ok(settings);
    }
    if (path === "/model-catalog") return ok(HARNESS_MODEL_CATALOG);
    if (path === "/navigation") return ok(navigation);
    if (path === "/canon/mcp-grants") return ok(appShellRead(url, method));
    if (path === "/work-status") return ok({ items: [] });
    if (path === "/sessions" && method === "POST") {
      fake.createBody = request.postDataJSON();
      storedSession = { id: chatId, title: String(fake.createBody?.title), kind: "chat", created_at: at, updated_at: at,
        last_activity_at: at, pinned: false, archived: false, attention_required: true, attention_source: "self",
        active_turn_state: "waiting_for_form", computer_id: remoteComputer.id, computer_name: remoteComputer.name };
      navigation.chats = [storedSession];
      return ok({ session: storedSession }, 201);
    }
    if (path === "/messages" && method === "POST") {
      const body = request.postDataJSON();
      const accepted: MessageRecord = { id: body.client_message_id, chat_id: chatId, turn_id: turnId, cursor: 1,
        role: "user", status: "sent", text: body.text, created_at: at };
      messages = [accepted];
      return ok({ accepted, replies: [] }, 202);
    }
    if (path === "/session-view") {
      const id = searchParams.get("session_id") ?? "";
      if (id !== chatId) return ok(session([], id));
      fake.sessionReads++;
      if (fake.unreachable) return route.fulfill({ status: 422, json: { error: { code: "ssh_unreachable" } } });
      return ok({ ...session(messages, id), title: storedSession?.title });
    }
    if (path === "/session-queue") return ok({ queued_messages: [] });
    if (path === "/authority-requests") return ok({ session_id: chatId, requests: [] });
    if (path.endsWith("/controls")) return ok({ session_id: chatId, revision: 0, catalog_generation: HARNESS_MODEL_CATALOG.generation,
      controls: { model: HARNESS_MODEL_CATALOG.default_model_ref, reasoning_effort: "none", access_mode: "ask_first", plan_mode: false } });
    if (path.endsWith("/pending-asks")) return ok({ session_id: chatId, asks: [], open_count: 0 });
    if (path === "/memory/instructions/pending") return ok({ pending: fake.pending.map((item) => ({ ...item, chat_id: chatId })) });
    if (path.startsWith("/memory/instructions/pending/") && method === "POST") {
      fake.decisions.push({ path, body: request.postDataJSON() });
      fake.pending = [];
      return ok({ ok: true });
    }
    if (path === `/turns/${turnId}/operations/memory-search/output`) return ok({ complete: true, content: JSON.stringify({
      ok: false, error: { code: "main_not_connected", message: "Raw gateway diagnostic" },
    }) });
    if (path === "/automations") return ok({ automations: [] });
    if (path.includes("wallpaper")) return ok({ modules: [], assets: [] });
    return ok({});
  });
  await installSmokeUiAssets(page, root);
  return fake;
}
