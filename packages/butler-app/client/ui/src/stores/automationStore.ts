import { appCopy } from "@/app/copy.ts";
import type { FormEvent } from "react";
import { create } from "zustand";
import { api } from "@/app/api.ts";
import { notifyError } from "@/app/notifications.ts";
import type {
  AccessMode,
  AutomationRunSummary,
  AutomationSummary,
  SessionOption,
  StatusPill,
} from "@/app/types.ts";
import { isAccessMode } from "@/components/conversation/accessModeUtils";
import {
  DEFAULT_SCHEDULE_ACCESS_MODE,
  automationSaveError,
  conversationAccessMode,
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
  /** The access the schedule's runs get, independent of the target conversation. */
  accessMode: AccessMode;
  /** True once the user picked a mode, so a new target no longer replaces it. */
  accessModeChosen: boolean;
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

let accessModeRequest = 0;

/**
 * A new schedule starts from its target conversation's current mode, or Ask
 * first when the UI cannot read it, until the user picks a mode.
 */
async function followTargetAccessMode(targetSessionId: string): Promise<void> {
  const request = ++accessModeRequest;
  const mode = await conversationAccessMode(targetSessionId);
  const current = useAutomationStore.getState();
  if (request !== accessModeRequest || !current.isNew || current.accessModeChosen) return;
  useAutomationStore.setState({ accessMode: mode ?? DEFAULT_SCHEDULE_ACCESS_MODE });
}

export const useAutomationStore = create<AutomationStore>((set, get) => ({
  // Initial state
  automationId: "",
  isNew: true,
  title: "",
  promptBody: "",
  targetSessionId: "",
  intervalSeconds: 1800,
  accessMode: DEFAULT_SCHEDULE_ACCESS_MODE,
  accessModeChosen: false,
  state: "enabled",
  runs: [],
  saving: false,
  saveError: null,
  sessionOptions: [],

  // Setters
  setTitle: (title) =>
    set((current) => ({ title, saveError: withoutFieldError(current.saveError, "title") })),
  setPromptBody: (promptBody) =>
    set((current) => ({ promptBody, saveError: withoutFieldError(current.saveError, "prompt") })),
  setTargetSessionId: async (targetSessionId) => {
    // A schedule always has a target. Inside a <form>, Radix Select's hidden
    // native select reports "" when the value arrives in the same render as
    // its options; ignoring it keeps the target (and the mode that follows it).
    if (!targetSessionId) return;
    set((current) => ({ targetSessionId, saveError: withoutFieldError(current.saveError, "form") }));
    const { isNew, accessModeChosen } = get();
    if (isNew && !accessModeChosen) await followTargetAccessMode(targetSessionId);
  },
  setIntervalSeconds: (intervalSeconds) =>
    set((current) => ({ intervalSeconds, saveError: withoutFieldError(current.saveError, "interval") })),
  setAccessMode: (accessMode) =>
    set((current) => ({
      accessMode,
      accessModeChosen: true,
      saveError: withoutFieldError(current.saveError, "accessMode"),
    })),

  // Initialize - loads automation data
  initialize: async (automationId, sessionOptions, onStatus) => {
    const isNew = !automationId || automationId === "new";
    accessModeRequest += 1;
    set({ automationId, isNew, sessionOptions, saveError: null, accessModeChosen: false });

    if (isNew) {
      const targetSessionId = sessionOptions[0]?.id ?? "general";
      set({
        title: "",
        promptBody: "",
        targetSessionId,
        intervalSeconds: 1800,
        accessMode: DEFAULT_SCHEDULE_ACCESS_MODE,
        state: "enabled",
        runs: [],
      });
      await followTargetAccessMode(targetSessionId);
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
        title: detail.automation.title,
        promptBody: detail.automation.prompt_body,
        targetSessionId: detail.automation.target_session_id,
        intervalSeconds: detail.automation.interval_seconds,
        accessMode: isAccessMode(detail.automation.access_mode)
          ? detail.automation.access_mode
          : DEFAULT_SCHEDULE_ACCESS_MODE,
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
    const { automationId, isNew, title, promptBody, targetSessionId, intervalSeconds, accessMode } = get();
    set({ saving: true, saveError: null });

    try {
      const body = JSON.stringify({
        title,
        prompt_body: promptBody,
        target_session_id: targetSessionId,
        interval_seconds: Number(intervalSeconds),
        access_mode: accessMode,
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
      onStatus({ label: "automation saved", tone: "ok" });
    } catch (error) {
      // A 400 is shown on its field; anything else stays a toast.
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
      onStatus({ label: `automation ${action}`, tone: "ok" });
    } catch (error) {
      notifyError(error, `${action} failed`, {
        id: `automation-${action}-${automationId}`,
      });
      onStatus({ label: "ready", tone: "ok" });
    }
  },

  // Remove automation
  remove: async (onSaved, onBack, onStatus) => {
    const { automationId, isNew } = get();
    if (isNew) return;

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
