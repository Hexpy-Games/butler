import { useCallback, useEffect, useRef, useState } from "react";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { useConversation } from "@/conversation/live";
import { Button, ListRow, Sheet, showToast } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";
import { GroupInset, LoadState, SettingsGroup, SettingsScreen } from "@/settings/layout";
import type { ComponentUpdateStatus, UpdateCancelResult, UpdateProgressView, UpdateStatusView } from "@/settings/types";

function useUpdates() {
  const { client, reconcile, subscribe } = useConversation();
  const S = getAppCopy(useAppLocale()).settings;
  const [view, setView] = useState<UpdateStatusView | null>(null);
  const [progress, setProgress] = useState<UpdateProgressView | null>(null);
  const [loading, setLoading] = useState(false), [applying, setApplying] = useState(false), [error, setError] = useState(false);
  const checked = useRef(false);
  const receive = useCallback((next?: UpdateProgressView | null) => {
    if (next) setProgress(old => !old || next.revision > old.revision ? next : old);
  }, []);
  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true); setError(false);
    try { const next = await client.request<UpdateStatusView>("/updates"); setView(next); receive(next.progress); }
    catch { setError(true); }
    finally { setLoading(false); }
  }, [client, receive]);
  const check = useCallback(async (silent = false) => {
    if (!client) return;
    setLoading(true);
    try { const next = await client.request<UpdateStatusView>("/updates/check", { method: "POST", body: { component: "app" } }); setView(next); receive(next.progress); }
    catch { if (!silent) showToast({ message: S.errors.checkUpdates, tone: "error" }); }
    finally { setLoading(false); }
  }, [client, receive, S.errors.checkUpdates]);
  useEffect(() => { void load(); }, [load, reconcile]);
  useEffect(() => {
    if (!checked.current && view?.components.some(c => c.check_state === "unchecked")) { checked.current = true; void check(true); }
  }, [view, check]);
  useEffect(() => subscribe(event => {
    if (event.type !== "updates.progress") return;
    const p = event.payload?.progress;
    if (!p || typeof p !== "object" || !("component" in p) || !("revision" in p) || !("cancellable" in p) || !("error_code" in p) || !("stage" in p) || (p.component !== "app" && p.component !== "service") || typeof p.revision !== "number" || typeof p.cancellable !== "boolean"
      || (p.error_code !== null && typeof p.error_code !== "string")) return;
    switch (p.stage) {
      case "idle": case "checking": case "downloading": case "verifying": case "ready": case "applying": case "restarting": case "failed": case "completed":
        receive({ component: p.component, revision: p.revision, stage: p.stage, cancellable: p.cancellable, error_code: p.error_code });
    }
  }), [subscribe, receive]);
  useEffect(() => { if (progress?.stage === "completed") void load(); }, [progress?.stage, load]);
  const apply = async () => {
    if (!client || applying) return;
    setApplying(true);
    try {
      const result = await client.request<ComponentUpdateStatus>("/updates/apply", { method: "POST", body: { component: "app" } });
      setView(old => ({ components: (old?.components ?? []).map(c => c.component === result.component ? result : c) }));
    } catch { showToast({ message: S.errors.applyUpdate, tone: "error" }); }
    finally { setApplying(false); }
  };
  const cancel = async () => {
    if (!client) return;
    try {
      const result = await client.request<UpdateCancelResult>("/updates/cancel", { method: "POST" });
      if (result.cancelled) showToast({ message: S.updateProgress.cancelled, tone: "neutral" });
      await load();
    } catch { showToast({ message: S.errors.applyUpdate, tone: "error" }); }
  };
  return { view, progress, loading, applying, error, load, check, apply, cancel };
}

export default function UpdatesSettings() {
  const S = getAppCopy(useAppLocale()).settings, M = useMobileCopy();
  const updates = useUpdates(), [confirm, setConfirm] = useState(false);
  const status = updates.view?.components.find(c => c.component === "app");
  const progress = updates.progress?.component === "app" ? updates.progress : null;
  const stage = progress?.error_code === "update_cancelled" ? "idle" : progress?.stage;
  const busy = stage === "checking" || stage === "verifying" || stage === "applying" || stage === "restarting";
  const applying = updates.applying || Boolean(stage && ["checking", "downloading", "verifying", "applying", "restarting"].includes(stage));
  const cancelling = stage === "downloading" && progress?.cancellable;
  const current = status?.current_version || "-";
  const version = status?.update_available ? `${current} -> ${status.available_version || current}` : current;
  const label = cancelling ? S.updateProgress.cancel : stage === "failed" ? S.updateProgress.retry : stage === "ready" ? S.updateProgress.restart
    : applying ? S.actions.updateApplying : status?.update_available ? S.actions.updateComponent
      : status?.check_state === "unavailable" ? S.actions.updateUnavailable : status?.check_state === "unchecked" ? S.actions.updateChecking : S.actions.upToDate;
  return <SettingsScreen title={S.sections.updates} description={S.sectionDescriptions.updates}>
    <SettingsGroup title={S.pageSections.updateVersions}>
      <GroupInset><Button variant="secondary" label={updates.loading ? S.actions.updateChecking : S.actions.checkUpdates} disabled={updates.loading || applying} onPress={() => void updates.check()} /></GroupInset>
      {!updates.view ? <GroupInset><LoadState error={updates.error} message={S.errors.loadUpdates} onRetry={updates.load} /></GroupInset> : <ListRow title={S.updateComponents.app}
        description={[version, status?.bundled_agent_version ? `Butler Agent ${status.bundled_agent_version}` : ""].filter(Boolean).join("\n")}
        meta={busy || stage === "ready" ? S.updateProgress[stage] : undefined}
        trailing={!busy && (stage !== "downloading" || cancelling) ? <Button size="sm" variant={cancelling || !status?.update_available ? "outline" : "default"} label={label}
          disabled={(!status?.update_available && stage !== "failed" && stage !== "ready" && !cancelling) || (applying && stage !== "ready" && !cancelling)}
          onPress={() => cancelling ? void updates.cancel() : setConfirm(true)} /> : undefined} />}
    </SettingsGroup>
    <Sheet open={confirm} onClose={() => setConfirm(false)} title={M.settings.applyUpdateTitle} description={M.settings.applyUpdateBody} cancelLabel={M.settings.cancel}
      action={<Button label={S.actions.updateComponent} onPress={() => { setConfirm(false); void updates.apply(); }} />} />
  </SettingsScreen>;
}
