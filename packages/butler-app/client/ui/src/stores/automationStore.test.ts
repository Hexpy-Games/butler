// test-category: race
/// <reference types="bun" />

import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import type { FormEvent } from "react";
import { toast } from "sonner";
import { appCopy, getAppLocale, setAppCopyLanguage } from "@/app/copy.ts";
import type { AccessMode } from "@/app/types.ts";
import { useAutomationStore } from "./automationStore.ts";

const initialLocale = getAppLocale();
const initialState = useAutomationStore.getState();
afterAll(() => {
  setAppCopyLanguage(initialLocale);
  useAutomationStore.setState(initialState, true);
});
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

const sessions = [
  { id: "chat-a", label: "A" },
  { id: "chat-b", label: "B" },
];
const submit = { preventDefault: () => undefined } as unknown as FormEvent<HTMLFormElement>;
const noop = () => undefined;
const saved = async () => undefined;

type Handler = (input: Record<string, unknown>) => unknown;

function installBridge(handlers: Record<string, Handler>) {
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const bridge = Object.fromEntries(
    Object.entries(handlers).map(([method, handler]) => [
      method,
      async (input: Record<string, unknown>) => {
        calls.push({ method, input });
        return await handler(input);
      },
    ]),
  );
  (globalThis as { window?: unknown }).window = {
    butlerApp: bridge,
    location: { origin: "http://127.0.0.1:5173" },
  };
  return calls;
}

function controlsFor(modes: Record<string, AccessMode>): Handler {
  return ({ sessionId }) => {
    const mode = modes[String(sessionId)];
    if (!mode) throw new Error("unknown chat");
    return { session_id: sessionId, controls: { access_mode: mode }, revision: 1 };
  };
}

function rejection(code: string, status: number) {
  return () => ({ ok: false, error: { schema: "butler.app.bridge-error.v1", code, status } });
}

function existingSchedule(access_mode: AccessMode): Handler {
  return () => ({
    automation: {
      id: "automation-1",
      title: "Morning brief",
      prompt_body: "Summarize my day.",
      target_session_id: "chat-a",
      target_label: "A",
      interval_seconds: 3600,
      schedule_type: "interval",
      state: "enabled",
      access_mode,
    },
  });
}

test("a new schedule preselects the target conversation's current access mode and sends it on create", async () => {
  const calls = installBridge({
    getSessionControls: controlsFor({ "chat-a": "full_access" }),
    createAutomation: () => ({ ok: true, data: { automation: {} } }),
  });
  await useAutomationStore.getState().initialize("new", sessions, noop);
  expect(useAutomationStore.getState().accessMode).toBe("full_access");

  useAutomationStore.getState().setTitle("Morning brief");
  useAutomationStore.getState().setPromptBody("Summarize my day.");
  await useAutomationStore.getState().save(submit, saved, noop);

  const create = calls.find((call) => call.method === "createAutomation");
  expect(create?.input).toMatchObject({
    title: "Morning brief",
    promptBody: "Summarize my day.",
    targetSessionId: "chat-a",
    intervalSeconds: 1800,
    accessMode: "full_access",
  });
});

test("a new schedule falls back to ask first when the target conversation's mode is unknown", async () => {
  installBridge({ getSessionControls: controlsFor({}) });
  await useAutomationStore.getState().initialize("new", sessions, noop);
  expect(useAutomationStore.getState().accessMode).toBe("ask_except_reads");
});

test("changing the target follows that conversation's mode until the user picks one", async () => {
  installBridge({ getSessionControls: controlsFor({ "chat-a": "ask_first", "chat-b": "full_access" }) });
  await useAutomationStore.getState().initialize("new", sessions, noop);
  expect(useAutomationStore.getState().accessMode).toBe("ask_first");

  await useAutomationStore.getState().setTargetSessionId("chat-b");
  expect(useAutomationStore.getState().accessMode).toBe("full_access");

  useAutomationStore.getState().setAccessMode("read_only");
  await useAutomationStore.getState().setTargetSessionId("chat-a");
  expect(useAutomationStore.getState().accessMode).toBe("read_only");
});

test("an empty target from the form's hidden select keeps the target and its mode", async () => {
  installBridge({ getSessionControls: controlsFor({ "chat-a": "full_access" }) });
  await useAutomationStore.getState().initialize("new", sessions, noop);
  await useAutomationStore.getState().setTargetSessionId("");
  expect(useAutomationStore.getState().targetSessionId).toBe("chat-a");
  expect(useAutomationStore.getState().accessMode).toBe("full_access");
});

test("editing preselects the schedule's own mode and sends the chosen mode on save", async () => {
  const calls = installBridge({
    getAutomation: existingSchedule("read_only"),
    listAutomationRuns: () => ({ runs: [] }),
    getSessionControls: controlsFor({ "chat-a": "full_access", "chat-b": "full_access" }),
    updateAutomation: () => ({ ok: true, data: { automation: {} } }),
  });
  await useAutomationStore.getState().initialize("automation-1", sessions, noop);
  expect(useAutomationStore.getState().accessMode).toBe("read_only");

  await useAutomationStore.getState().setTargetSessionId("chat-b");
  expect(useAutomationStore.getState().accessMode).toBe("read_only");
  expect(calls.some((call) => call.method === "getSessionControls")).toBe(false);

  useAutomationStore.getState().setAccessMode("ask_first");
  await useAutomationStore.getState().save(submit, saved, noop);
  const update = calls.find((call) => call.method === "updateAutomation");
  expect(update?.input).toMatchObject({
    automationId: "automation-1",
    targetSessionId: "chat-b",
    accessMode: "ask_first",
  });
});

test("400 validation errors are shown on the field, not as a toast, and clear when the field changes", async () => {
  setAppCopyLanguage("ko");
  const toastError = spyOn(toast, "error");
  try {
    for (const [code, field] of [
      ["automation_title_required", "title"],
      ["automation_prompt_required", "prompt"],
      ["automation_interval_invalid", "interval"],
      ["invalid_json", "accessMode"],
    ] as const) {
      installBridge({
        getSessionControls: controlsFor({}),
        createAutomation: rejection(code, 400),
      });
      await useAutomationStore.getState().initialize("new", sessions, noop);
      await useAutomationStore.getState().save(submit, saved, noop);
      expect(useAutomationStore.getState().saveError).toEqual({
        field,
        message: appCopy.automations.errors[field],
      });
    }
    expect(toastError).not.toHaveBeenCalled();

    useAutomationStore.getState().setAccessMode("full_access");
    expect(useAutomationStore.getState().saveError).toBeNull();

    installBridge({ getSessionControls: controlsFor({}), createAutomation: rejection("automation_title_required", 400) });
    await useAutomationStore.getState().initialize("new", sessions, noop);
    await useAutomationStore.getState().save(submit, saved, noop);
    useAutomationStore.getState().setPromptBody("x");
    expect(useAutomationStore.getState().saveError?.field).toBe("title");
    useAutomationStore.getState().setTitle("x");
    expect(useAutomationStore.getState().saveError).toBeNull();
  } finally {
    toastError.mockRestore();
  }
});

test("an unmapped 400 is shown inline on the form; other failures stay a toast", async () => {
  setAppCopyLanguage("en");
  const toastError = spyOn(toast, "error");
  try {
    installBridge({ getSessionControls: controlsFor({}), createAutomation: rejection("automation_state_invalid", 400) });
    await useAutomationStore.getState().initialize("new", sessions, noop);
    await useAutomationStore.getState().save(submit, saved, noop);
    expect(useAutomationStore.getState().saveError).toEqual({
      field: "form",
      message: appCopy.automations.errors.invalid,
    });
    expect(toastError).not.toHaveBeenCalled();

    installBridge({ getSessionControls: controlsFor({}), createAutomation: rejection("internal_error", 500) });
    await useAutomationStore.getState().initialize("new", sessions, noop);
    await useAutomationStore.getState().save(submit, saved, noop);
    expect(useAutomationStore.getState().saveError).toBeNull();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0]?.[0]).toBe(appCopy.automations.saveFailed);
  } finally {
    toastError.mockRestore();
  }
});
