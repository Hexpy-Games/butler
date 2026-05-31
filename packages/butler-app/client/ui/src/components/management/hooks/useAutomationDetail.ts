import { useEffect, useState } from "react";
import { api } from "@/app/api.ts";
import { notifyError } from "@/app/notifications.ts";
import type {
  AutomationRunSummary,
  AutomationSummary,
  SessionOption,
  StatusPill,
} from "@/app/types.ts";

export function useAutomationDetail(
  automationId: string,
  sessionOptions: SessionOption[],
  onStatus: (status: StatusPill) => void,
) {
  const isNew = !automationId || automationId === "new";
  const [title, setTitle] = useState("");
  const [promptBody, setPromptBody] = useState("");
  const [targetSessionId, setTargetSessionId] = useState("");
  const [intervalSeconds, setIntervalSeconds] = useState(1800);
  const [state, setState] = useState("enabled");
  const [runs, setRuns] = useState<AutomationRunSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (isNew) {
        setTitle("");
        setPromptBody("");
        setTargetSessionId(sessionOptions[0]?.id ?? "general");
        setIntervalSeconds(1800);
        setState("enabled");
        setRuns([]);
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
        if (!cancelled) {
          setTitle(detail.automation.title);
          setPromptBody(detail.automation.prompt_body);
          setTargetSessionId(detail.automation.target_session_id);
          setIntervalSeconds(detail.automation.interval_seconds);
          setState(detail.automation.state);
          setRuns(runList.runs ?? []);
        }
      } catch (error) {
        if (!cancelled) {
          notifyError(error, "Automation detail failed", {
            id: `automation-detail-${automationId}`,
          });
          onStatus({ label: "ready", tone: "ok" });
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [automationId, isNew, onStatus, sessionOptions]);

  return {
    isNew,
    title,
    setTitle,
    promptBody,
    setPromptBody,
    targetSessionId,
    setTargetSessionId,
    intervalSeconds,
    setIntervalSeconds,
    state,
    setState,
    runs,
  };
}