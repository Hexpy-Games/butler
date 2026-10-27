import { confirmAction } from "@/app/confirmation.ts";
import { hintScheduleLogin } from "@/app/loginSettings";
import { appCopy } from "@/app/copy.ts";
import type { FormEvent } from "react";
import { create } from "zustand";
import { api } from "@/app/api.ts";
import { notifyError } from "@/app/notifications.ts";
import type {
  CalendarSchedule,
  AccessMode,
  AutomationRunSummary,
  AutomationSummary,
  SessionOption,
  StatusPill,
} from "@/app/types.ts";
import { useButlerStore } from "@/app/store.ts";
import { isAccessMode } from "@/components/conversation/accessModeUtils";
import {
  DEFAULT_SCHEDULE_ACCESS_MODE,
  automationSaveError,
  scheduleDefaultAccessMode,
  withoutFieldError,
  type AutomationSaveError,
} from "./automationForm.ts";

interface AutomationStore {
  // State
  automationId: string;
  isNew: boolean;
  title: string;
  promptBody: string;
  targetSessionId: string;
  intervalSeconds: number;
  schedule: CalendarSchedule | null;
  setSchedule: (schedule: CalendarSchedule | null) => void;
  scheduleType: string;
  runAt?: string;
  startAt?: string;
  /** The access the schedule's runs get, independent of the target conversation. */
  accessMode: AccessMode;
  browserSignin: boolean;
  browserPayment: boolean;
  setBrowserSignin: (on: boolean) => void;
  setBrowserPayment: (on: boolean) => void;
  /** The schedule's own model; empty follows the target chat's model. */
  model: string;
  /** The model as loaded, so a save sends `model` only when it changed. */
  initialModel: string;
  state: string;
  runs: AutomationRunSummary[];
  saving: boolean;
  /** The last save the gateway refused as invalid, shown on its field. */
  saveError: AutomationSaveError | null;
  sessionOptions: SessionOption[];

  // Setters
  setTitle: (title: string) => void;
  setPromptBody: (body: string) => void;
  setTargetSessionId: (id: string) => Promise<void>;
  setIntervalSeconds: (seconds: number) => void;
  setAccessMode: (mode: AccessMode) => void;
  setModel: (model: string) => void;

  // Actions
  initialize: (
    automationId: string,
    sessionOptions: SessionOption[],
    onStatus: (status: StatusPill) => void,
  ) => Promise<void>;
  save: (
    event: FormEvent<HTMLFormElement>,
    onSaved: () => Promise<void>,
    onStatus: (status: StatusPill) => void,
  ) => Promise<void>;
  mutate: (
    action: "run" | "pause" | "resume",
    onSaved: () => Promise<void>,
    onStatus: (status: StatusPill) => void,
  ) => Promise<void>;
  remove: (
    onSaved: () => Promise<void>,
    onBack: () => void,
    onStatus: (status: StatusPill) => void,
  ) => Promise<void>;
}

export const useAutomationStore = create<AutomationStore>((set, get) => ({
  // Initial state
  automationId: "",
  isNew: true,
  title: "",
  promptBody: "",
  targetSessionId: "",
  intervalSeconds: 1800,
  schedule: null,
  scheduleType: "interval",
  accessMode: DEFAULT_SCHEDULE_ACCESS_MODE,
  model: "",
  initialModel: "",
  state: "enabled",
  runs: [],
  saving: false,
  saveError: null,
  sessionOptions: [],

  browserSignin: false,
  browserPayment: false,
  setBrowserSignin: (browserSignin) => set({ browserSignin }),
  setBrowserPayment: (browserPayment) => set({ browserPayment }),

  // Setters
  setSchedule: (schedule) => set((current) => ({ schedule, scheduleType: schedule?.kind ?? "interval", saveError: withoutFieldError(current.saveError, "interval") })),
  setTitle: (title) =>
    set((current) => ({ title, saveError: withoutFieldError(current.saveError, "title") })),
  setPromptBody: (promptBody) =>
    set((current) => ({ promptBody, saveError: withoutFieldError(current.saveError, "prompt") })),
  setTargetSessionId: async (targetSessionId) => {
    // A schedule always has a target. Inside a <form>, Radix Select's hidden
    // native select reports "" when the value arrives in the same render as
    // its options; ignoring it keeps the target.
    if (!targetSessionId) return;
    set((current) => ({ targetSessionId, saveError: withoutFieldError(current.saveError, "form") }));
  },
  setIntervalSeconds: (intervalSeconds) =>
    set((current) => ({ intervalSeconds, saveError: withoutFieldError(current.saveError, "interval") })),
  setAccessMode: (accessMode) =>
    set((current) => ({
      accessMode,
      saveError: withoutFieldError(current.saveError, "accessMode"),
    })),
  setModel: (model) =>
    set((current) => ({ model, saveError: withoutFieldError(current.saveError, "model") })),

  // Initialize - loads automation data
  initialize: async (automationId, sessionOptions, onStatus) => {
    const isNew = !automationId || automationId === "new";
    set({ automationId, isNew, sessionOptions, saveError: null });

    if (isNew) {
      const targetSessionId = sessionOptions[0]?.id ?? "general";
      set({
        browserSignin: false,
        browserPayment: false,
        title: "",
        promptBody: "",
        targetSessionId,
        intervalSeconds: 1800,
        schedule: null,
        scheduleType: "interval",
        runAt: undefined,
        startAt: undefined,
        // Unattended runs start from the schedule default (D7), not the chat's mode.
        accessMode: scheduleDefaultAccessMode(useButlerStore.getState().settings),
        model: "",
        initialModel: "",
        state: "enabled",
        runs: [],
      });
      return;
    }

    try {
      const detail = await api<{
        automation: AutomationSummary & {
          prompt_body: string;
          target_session_id: string;
          interval_seconds: number;
        };
      }>(`/automations/${encodeURIComponent(automationId)}`);
      const runList = await api<{ runs: AutomationRunSummary[] }>(
        `/automations/${encodeURIComponent(automationId)}/runs`,
      );

      set({
        browserSignin: detail.automation.browser_signin === true,
        browserPayment: detail.automation.browser_payment === true,
        title: detail.automation.title,
        promptBody: detail.automation.prompt_body,
        targetSessionId: detail.automation.target_session_id,
        intervalSeconds: detail.automation.interval_seconds,
        schedule: detail.automation.schedule ?? null,
        scheduleType: detail.automation.schedule_type ?? "interval",
        runAt: (detail.automation as { run_at?: string }).run_at,
        startAt: (detail.automation as { start_at?: string }).start_at,
        accessMode: isAccessMode(detail.automation.access_mode)
          ? detail.automation.access_mode
          : DEFAULT_SCHEDULE_ACCESS_MODE,
        model: detail.automation.model ?? "",
        initialModel: detail.automation.model ?? "",
        state: detail.automation.state,
        runs: runList.runs ?? [],
      });
    } catch (error) {
      notifyError(error, appCopy.interfacePanels.automationDetailFailed, {
        id: `automation-detail-${automationId}`,
      });
      onStatus({ label: "ready", tone: "ok" });
    }
  },

  // Save automation
  save: async (event, onSaved, onStatus) => {
    event.preventDefault();
    const { automationId, isNew, title, promptBody, targetSessionId, intervalSeconds, accessMode, model, initialModel, schedule, scheduleType, runAt, startAt } = get();
    set({ saving: true, saveError: null });

    try {
      const body = JSON.stringify({
        browser_signin: get().browserSignin,
        browser_payment: get().browserPayment,
        title,
        prompt_body: promptBody,
        target_session_id: targetSessionId,
        interval_seconds: Number(intervalSeconds),
        access_mode: accessMode,
        schedule,
        schedule_type: scheduleType,
        run_at: runAt,
        start_at: startAt,
        // An untouched model stays as it was; a new schedule then follows its chat.
        ...(model !== initialModel ? { model } : {}),
      });

      if (isNew) {
        await api("/automations", { method: "POST", body });
      } else {
        await api(`/automations/${encodeURIComponent(automationId)}`, {
          method: "PATCH",
          body,
        });
      }
      await onSaved();
      if (isNew) void hintScheduleLogin();
      onStatus({ label: appCopy.automations.saved, tone: "ok" });
    } catch (error) {
      // A refused field is shown on that field; anything else stays a toast.
      const saveError = automationSaveError(error);
      if (saveError) set({ saveError });
      else {
        notifyError(error, appCopy.automations.saveFailed, {
          id: `automation-save-${automationId}`,
        });
      }
      onStatus({ label: "ready", tone: "ok" });
    } finally {
      set({ saving: false });
    }
  },

  // Mutate automation (run, pause, resume)
  mutate: async (action, onSaved, onStatus) => {
    const { automationId, isNew } = get();
    if (isNew) return;

    try {
      await api(`/automations/${encodeURIComponent(automationId)}/${action}`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      await onSaved();
      onStatus({ label: appCopy.automations.saved, tone: "ok" });
    } catch (error) {
      notifyError(error, `${action} failed`, {
        id: `automation-${action}-${automationId}`,
      });
      onStatus({ label: "ready", tone: "ok" });
    }
  },

  // Remove automation
  remove: async (onSaved, onBack, onStatus) => {
    const { automationId, isNew, title } = get();
    if (isNew) return;
    if (!await confirmAction(appCopy.settings.deleteSchedule(title), {
      title: appCopy.common.delete, confirmLabel: appCopy.common.delete, destructive: true,
    })) return;

    try {
      await api(`/automations/${encodeURIComponent(automationId)}`, {
        method: "DELETE",
      });
      await onSaved();
      onBack();
    } catch (error) {
      notifyError(error, "Delete failed", {
        id: `automation-delete-${automationId}`,
      });
      onStatus({ label: "ready", tone: "ok" });
    }
  },
}));
