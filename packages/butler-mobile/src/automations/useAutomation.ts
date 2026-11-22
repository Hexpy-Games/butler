import { useCallback, useState } from "react";
import { useFocusEffect } from "expo-router";
import type { AutomationRunSummary, AutomationSummary } from "../../../butler-protocol/src/index.ts";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { useConversation } from "@/conversation/live";
import { showToast } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";

export function useAutomation(id: string) {
  const { client } = useConversation();
  const copy = getAppCopy(useAppLocale()).automations, M = useMobileCopy();
  const [automation, setAutomation] = useState<AutomationSummary | null>(null);
  const [runs, setRuns] = useState<AutomationRunSummary[]>([]);
  const [error, setError] = useState(false), [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const path = `/automations/${encodeURIComponent(id)}`;
  const load = useCallback(async () => {
    setError(false);
    try {
      const [detail, history] = await Promise.all([
        client!.request<{ automation: AutomationSummary }>(path),
        client!.request<{ runs: AutomationRunSummary[] }>(`${path}/runs`),
      ]);
      setAutomation(detail.automation); setRuns(history.runs);
    } catch { setError(true); }
  }, [client, path]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  const act = async (kind: "run" | "pause" | "resume") => {
    setBusy(true);
    try {
      await client!.request(`${path}/${kind}`, { method: "POST", body: {} });
      showToast({ message: copy.actionDone[kind], tone: "success" });
    } catch { showToast({ message: copy.actionFailed[kind], tone: "error" }); }
    await load();
    setBusy(false);
  };
  const remove = async (): Promise<boolean> => {
    setDeleting(true);
    try { await client!.request(path, { method: "DELETE" }); return true; }
    catch { showToast({ message: M.automations.deleteFailed, tone: "error" }); return false; }
    finally { setDeleting(false); }
  };
  return { automation, runs, error, busy, deleting, load, act, remove };
}
