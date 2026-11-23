import { useCallback, useEffect, useRef, useState } from "react";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import type { AutomationDetail, AutomationSummary } from "../../../butler-protocol/src/index.ts";
import { useConversation } from "@/conversation/live";
import { useNavigationView } from "@/conversation/useNavigationView";
import { showToast } from "@/ds";
import { useAppLocale } from "@/i18n";
import { useSettings } from "@/settings/useSettings";
import {
  draftFromDetail, newDraft, saveError, savePayload, withoutFieldError,
  type AutomationDraft, type AutomationFormField, type AutomationSaveError,
} from "./automationForm";

export function useAutomationForm(id?: string) {
  const { client } = useConversation();
  const copy = getAppCopy(useAppLocale()).automations;
  const { settings, error: settingsError } = useSettings();
  const { view, error: navigationError } = useNavigationView();
  const [draft, setDraft] = useState<AutomationDraft | null>(null);
  const [error, setError] = useState<AutomationSaveError | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const savePending = useRef(false);
  const path = id ? `/automations/${encodeURIComponent(id)}` : "/automations";
  const load = useCallback(async () => {
    if (!client || !id) return;
    setLoadError(false);
    try {
      const { automation } = await client.request<{ automation: AutomationDetail }>(path);
      setDraft(draftFromDetail(automation));
    } catch { setLoadError(true); }
  }, [client, id, path]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (id || (!settings && !settingsError) || (!view && !navigationError)) return;
    const target = view?.chats[0]?.id ?? view?.projects.find(p => p.sessions?.length)?.sessions?.[0]?.id ?? "general";
    setDraft(current => current ?? newDraft(target, settings?.schedule_access_mode ?? "auto"));
  }, [id, settings, settingsError, view, navigationError]);

  const set = (update: (current: AutomationDraft) => AutomationDraft, field: AutomationFormField) => {
    setDraft(current => current && update(current));
    setError(current => withoutFieldError(current, field));
  };
  const save = async (): Promise<AutomationSummary | undefined> => {
    if (saving || savePending.current || !draft || !client) return;
    savePending.current = true;
    setSaving(true);
    setError(null);
    try {
      const { automation } = await client.request<{ automation: AutomationSummary }>(path, {
        method: id ? "PATCH" : "POST", body: savePayload(draft),
      });
      return automation;
    } catch (failure) {
      const field = saveError(failure);
      if (field) setError({ field, message: copy.errors[field === "form" ? "invalid" : field] });
      else showToast({ message: copy.saveFailed, tone: "error" });
    } finally {
      savePending.current = false;
      setSaving(false);
    }
  };
  return { draft, set, error, loadError, load, saving, save };
}
