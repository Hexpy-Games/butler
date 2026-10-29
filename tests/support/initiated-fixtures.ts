import { EMPTY_SETTINGS } from "../../packages/butler-app/client/ui/src/app/constants";
import { HARNESS_MODEL_CATALOG, HARNESS_NAVIGATION, HARNESS_SS03_OBSERVER_VIEW } from "../../packages/butler-app/client/ui/src/app/fixtures";
import { onboardingCompletedPatch } from "../../packages/butler-app/client/ui/src/app/onboarding";
import type { MessageRecord, SessionView } from "../../packages/butler-app/client/ui/src/app/types";
import type { PatternProposalPanel } from "../../packages/butler-app/client/ui/src/app/initiatedTypes";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Page } from "playwright";
import { installSmokeUiAssets } from "./smoke-ui-assets";

export const proposal: PatternProposalPanel = { kind: "pattern_proposal", bundle_id: "bundle-1", candidates: [
  { pattern_id: "pattern-1", state: "pending", title: "아침에 경제 소식을 자주 확인하셨어요", action: { title: "환율·미국 증시 정리", schedule: { type: "daily", time: "07:50" }, deliver_to: "chats" },
    evidence: { count: 11, first_at: "2026-10-06T00:00:00Z", last_at: "2026-10-26T00:00:00Z" } },
  { pattern_id: "pattern-2", state: "pending", title: "평일마다 일정을 살펴보셨어요", action: { title: "오늘 일정 정리", schedule: { type: "weekdays", time: "08:30" }, deliver_to: "chats" },
    evidence: { count: 8, first_at: "2026-10-06T00:00:00Z", last_at: "2026-10-26T00:00:00Z" } },
] };
export function initiatedMessage(kind: "proposal" | "report" | "pause", en = false): MessageRecord {
  const base: MessageRecord = { id: kind, chat_id: "general", role: "assistant", status: "delivered", cursor: 1, created_at: "2026-10-26T23:00:00Z", text: "" };
  if (kind === "proposal") return { ...base, text: en ? "Want me to get these ready before you ask?" : "자주 찾으시는 걸 미리 준비해 둘까요?",
    initiated: { kind: "pattern_proposal", quiet: false, panel: structuredClone(proposal) } };
  if (kind === "pause") return { ...base, text: "‘아침 소식’ 보고를 3번 연속 안 열어보셔서 잠시 멈춰 뒀어요. 계속 받으실래요?",
    initiated: { kind: "schedule_pause", quiet: false, automation_id: "schedule-1", automation_title: "아침 소식", panel: {
      kind: "schedule_pause", automation_id: "schedule-1", state: "pending", title: "아침 소식", schedule: { type: "daily", time: "07:50" }, unopened_count: 3,
    } } };
  return { ...base, text: "오늘 아침 소식을 정리했어요. 자세한 내용은 문서로 드릴게요.",
    initiated: { kind: "schedule_report", quiet: false, automation_id: "schedule-1", automation_title: "아침 소식" }, artifacts: [{
      id: "report-document", session_id: "general", message_id: "report", title: "아침 소식.md", kind: "document", safe_path_label: "아침 소식.md",
      deliverable: true, size_bytes: 6104, url: "/message-files/file-00000000-0000-4000-8000-000000000001", created_at: base.created_at!,
    }] };
}
export function session(messages: MessageRecord[], id = "general"): SessionView {
  return { ...HARNESS_SS03_OBSERVER_VIEW, session_id: id, kind: "chat", parent_session_id: undefined, relation: undefined,
    messages, active_turn: null, latest_turn: null, artifacts: [], authority_requests: [], pending_questions: [], steward_children: [], status: "idle",
    message_window: { next_cursor: messages.length, complete: true }, cursors: { messages: messages.length, events: 0 } };
}

/** Stub gateway transport only: real App bootstrap, subscription, navigation and composer. */
export async function installInitiatedGateway(page: Page, language: "ko" | "en", theme: "light" | "dark", initial?: SessionView, projectChat = false) {
  const root = resolve(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist");
  const navigation = structuredClone(HARNESS_NAVIGATION);
  const general = { id: "general", kind: "chat" as const, title: "Chats", unread: false, pinned: false, archived: false, created_at: "2026-10-27T00:00:00Z", updated_at: "2026-10-27T00:00:00Z", last_activity_at: "2026-10-27T00:00:00Z" };
  navigation.chats = [general, { ...general, id: "other", title: "다른 대화" }];
  navigation.projects = projectChat ? navigation.projects : [];
  const projectSessions = navigation.projects.flatMap(project => (project.sessions ?? []).map(chat => ({
    key: `s:${chat.id}`, kind: "session" as const, entityId: chat.id, parentKey: null, position: 2,
    revision: 1, manualPlacement: false, scopeProjectId: project.id,
  })));

  navigation.space = { revision: 1, groups: [], nodes: [...navigation.chats.map((chat, index) => ({ key: `s:${chat.id}`, kind: "session" as const, entityId: chat.id, parentKey: null, position: index, revision: 1, manualPlacement: false, scopeProjectId: null })), ...projectSessions] };
  let view = initial ?? session([initiatedMessage("proposal", language === "en")]);
  let settings = { ...EMPTY_SETTINGS, ...onboardingCompletedPatch(undefined, "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z"),
    language, appearance_theme: theme, timezone: "Asia/Seoul", chats_intro_seen: true, model: HARNESS_MODEL_CATALOG.default_model_ref,
    conversation_background: { source: { kind: "none" as const }, overlay: 0 } };
  const requests: { path: string; body: unknown; at: number }[] = [];
  await page.addInitScript(code => {
    if (!localStorage.getItem("butler:app-ui-state:v1")) localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({ schema: "butler.app-ui-state.v1", cached_at: new Date().toISOString(), active_session_id: "general", left_open: true, right_open: false }));
    const notifications: unknown[] = [];
    Object.assign(window, { __notifications: notifications });
    const ipcRenderer = {
      invoke: async (channel: string, input: unknown) => {
        if (channel === "butler:get-server-url") return "http://127.0.0.1:43827";
        if (channel === "butler:get-local-auth-headers") return {};
        if (channel === "butler:app-update-state") return { status: "idle", request_id: null };
        if (channel === "butler:agent-state") return { state: "running" };
        if (channel === "butler:show-desktop-notification") { notifications.push(input); return { ok: true }; }
        return null;
      }, on() {}, removeListener() {}, send() {},
    };
    const contextBridge = { exposeInMainWorld(name: string, value: Record<string, unknown>) {
      if (name !== "butlerApp") return;
      value = { ...value };
      value.subscribeLiveEvents = (_input: unknown, handlers: { onEvent: (event: unknown) => void; onOpen: () => void }) => {
        Object.assign(window, { __emitWorkEvent: handlers.onEvent });
        queueMicrotask(() => handlers.onOpen());
        return () => {};
      };
      Object.assign(window, { butlerApp: value });
    } };
    new Function("require", "process", code)(() => ({ contextBridge, ipcRenderer }), {
      env: { BUTLER_APP_SERVER_URL: "http://127.0.0.1:43827" }, argv: [], platform: "darwin",
    });
  }, readFileSync("packages/butler-app/client/electron/preload.cjs", "utf8"));
  await page.clock.install({ time: new Date("2026-10-26T21:00:00Z") });
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://127.0.0.1:43827") return route.abort();
    const path = url.pathname;
    const send = (data: unknown) => route.fulfill({ json: { protocol_version: "butler.app.v1", data } });
    if (path === "/") return route.fulfill({ contentType: "text/html", body: readFileSync(join(root, "index.html"), "utf8") });
    if (path.startsWith("/assets/")) return route.fallback();
    if (route.request().method() === "POST") requests.push({ path, body: route.request().postDataJSON(), at: Date.now() });
    if (path === "/settings") {
      if (route.request().method() === "PATCH") settings = { ...settings, ...route.request().postDataJSON() };
      return send(settings);
    }
    if (path === "/navigation") return send(navigation);
    if (path === "/model-catalog") return send(HARNESS_MODEL_CATALOG);
    if (path === "/session-view") {
      const id = url.searchParams.get("session_id");
      if (id && id !== view.session_id) return send(session([], id));
      return send(view);
    }
    if (path === "/authority-requests") return send({ session_id: "general", requests: view.authority_requests ?? [] });
    if (path === "/messages") return send({ messages: view.messages, next_cursor: view.messages.length });
    if (path === "/session-queue") return send({ queued_messages: [] });
    if (path.endsWith("/controls")) return send({ session_id: url.pathname.split("/")[2], revision: 0, catalog_generation: HARNESS_MODEL_CATALOG.generation,
      controls: { model: HARNESS_MODEL_CATALOG.default_model_ref, reasoning_effort: "none", access_mode: "ask_first", plan_mode: false } });
    if (path === "/sessions/general/read") general.unread = false;
    if (path === "/memory/pattern-proposals") return send({ revision: 7, bundles: [proposal] });
    if (path === "/automations/schedule-1") return send({ automation: { id: "schedule-1", title: "환율·미국 증시 정리", prompt_body: "소식 정리", target_session_id: "general", target_label: "대화",
      state: "enabled", interval_seconds: 86400, access_mode: "ask_first", schedule_type: "daily", schedule: { kind: "daily", time: "07:50", tz: "Asia/Seoul", weekdays: [] }, next_run_at: "2026-10-27T22:50:00Z" } });
    if (path === "/automations") return send({ automations: [] });
    if (path.endsWith("/runs")) return send({ runs: [] });
    if (path.endsWith("/pending-asks")) return send({ session_id: "general", asks: [], open_count: 0 });
    if (path.includes("wallpaper")) return send({ modules: [], assets: [] });
    return send({});
  });
  await installSmokeUiAssets(page, root);
  let eventId = 100;
  const emit = async (type: string, payload: unknown) => {
    await page.waitForFunction(() => typeof (window as unknown as { __emitWorkEvent?: unknown }).__emitWorkEvent === "function");
    await page.evaluate(event => (window as unknown as { __emitWorkEvent: (event: unknown) => void }).__emitWorkEvent(event), {
      id: ++eventId, type, created_at: "2026-10-26T21:00:00Z", payload,
    });
  };
  return { requests, async showView(next: SessionView) {
    view = next;
    await page.evaluate(id => {
      const key = "butler:app-ui-state:v1";
      const cached = JSON.parse(localStorage.getItem(key)!);
      localStorage.setItem(key, JSON.stringify({ ...cached, active_session_id: id }));
    }, next.session_id);
    await page.reload();
  }, async show(message: MessageRecord) {
    const sameMessage = view.messages[0]?.id === message.id;
    view = session([message]);
    if (!sameMessage) await page.reload();
    else await emit("message.updated", { session_id: "general", message });
  }, async arrive(message: MessageRecord) {
    view = session([message]); general.unread = true;
    await emit("message.created", { session_id: "general", message });
  }, async approval(scheduleType: "daily" | "weekdays" = "weekdays") {
    view = { ...session([]), authority_requests: [{ request_ref: "approval-1", category: "reviewed_effect", reason: "Create a schedule", executable: "create_automation", command_count: 1,
      approval: { action_kind: "manage_schedule", targets: [{ kind: "schedule", path: "automation:create:daily-news" }], count: 1, examples: [], risk: "medium",
        schedule: { title: "아침 소식", schedule_type: scheduleType, time: "07:50" } } }] };
    await emit("message.updated", { session_id: "general" });
  } };
}
