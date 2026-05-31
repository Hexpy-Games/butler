import type { FormEvent } from "react";
import { create } from "zustand";
import { api } from "@/app/api.ts";
import { notifyError } from "@/app/notifications.ts";
import type {
  AutomationRunSummary,
  AutomationSummary,
  SessionOption,
  StatusPill,
} from "@/app/types.ts";

interface AutomationStore {
  // State
  automationId: string;
  isNew: boolean;
  title: string;
  promptBody: string;
  targetSessionId: string;
  intervalSeconds: number;
  state: string;
  runs: AutomationRunSummary[];
  saving: boolean;
  sessionOptions: SessionOption[];

  // Setters
  setTitle: (title: string) => void;
  setPromptBody: (body: string) => void;
  setTargetSessionId: (id: string) => void;
  setIntervalSeconds: (seconds: number) => void;

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
  state: "enabled",
  runs: [],
  saving: false,
  sessionOptions: [],

  // Setters
  setTitle: (title) => set({ title }),
  setPromptBody: (promptBody) => set({ promptBody }),
  setTargetSessionId: (targetSessionId) => set({ targetSessionId }),
  setIntervalSeconds: (intervalSeconds) => set({ intervalSeconds }),

  // Initialize - loads automation data
  initialize: async (automationId, sessionOptions, onStatus) => {
    const isNew = !automationId || automationId === "new";
    set({ automationId, isNew, sessionOptions });

    if (isNew) {
      set({
        title: "",
        promptBody: "",
        targetSessionId: sessionOptions[0]?.id ?? "general",
        intervalSeconds: 1800,
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
        title: detail.automation.title,
        promptBody: detail.automation.prompt_body,
        targetSessionId: detail.automation.target_session_id,
        intervalSeconds: detail.automation.interval_seconds,
        state: detail.automation.state,
        runs: runList.runs ?? [],
      });
    } catch (error) {
      notifyError(error, "Automation detail failed", {
        id: `automation-detail-${automationId}`,
      });
      onStatus({ label: "ready", tone: "ok" });
    }
  },

  // Save automation
  save: async (event, onSaved, onStatus) => {
    event.preventDefault();
    const { automationId, isNew, title, promptBody, targetSessionId, intervalSeconds } = get();
    set({ saving: true });

    try {
      const body = JSON.stringify({
        title,
        prompt_body: promptBody,
        target_session_id: targetSessionId,
        interval_seconds: Number(intervalSeconds),
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
      notifyError(error, "Automation save failed", {
        id: `automation-save-${automationId}`,
      });
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
