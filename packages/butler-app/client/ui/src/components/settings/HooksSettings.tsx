import { useEffect, useState } from "react";
import { api } from "@/app/api.ts";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import { Button, CardList, Dialog, DialogContent, DialogHeader, DialogTitle, Plus } from "@/butler-ds";
import { confirmAction } from "@/app/confirmation.ts";
import { HookRow } from "./HookRow";
import { HookRuns } from "./HookRuns";
import { SettingsPage, SettingsSection } from "./SettingsFormComponents";
import { HookForm } from "./HookForm";
import { emptyHook, type HookDefinition, type HookRun, type HookSettings } from "./hooksTypes";
export function HooksSettings() {
  useAppLocale();
  const copy = appCopy.settings.hooks;
  const [settings, setSettings] = useState<HookSettings | null>(null);
  const [runs, setRuns] = useState<HookRun[]>([]);
  const [editing, setEditing] = useState<HookDefinition | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function refresh() {
    try {
      const [settings, runs] = await Promise.all([api<HookSettings>("/hooks"), api<HookRun[]>("/hooks/runs")]);
      setSettings(settings); setRuns(runs); setFailed(false);
      if (settings.error) notifyError(new Error(settings.error), appCopy.interfaceFeedback.requestFailed);
    } catch { setFailed(true); }
  }
  useEffect(() => { void refresh(); }, []);
  async function save(hooks: HookDefinition[]) {
    if (!settings) return;
    setBusy(true);
    try {
      setSettings(await api<HookSettings>("/hooks", { method: "PUT", body: JSON.stringify({
        revision: settings.revision, config: { version: 1, hooks },
      }) }));
      setEditing(null);
    } catch (error) { notifyError(error, appCopy.interfaceFeedback.requestFailed); await refresh(); }
    finally { setBusy(false); }
  }
  async function test(hook: HookDefinition) {
    setBusy(true);
    try {
      const run = await api<HookRun>(`/hooks/${hook.id}/test`, { method: "POST", body: "{}" });
      notifyStatus(`${run.outcome === "continue" ? copy.testSuccess : copy.testFailure} · ${run.duration_ms} ms`,
        { tone: run.outcome === "continue" ? "ok" : "error" });
      await refresh();
    } catch (error) { notifyError(error, appCopy.interfaceFeedback.requestFailed); }
    finally { setBusy(false); }
  }
  const hooks = settings?.config.hooks ?? [];
  async function remove(hook: HookDefinition) {
    if (await confirmAction(copy.deleteConfirm(hook.name || hook.id), {
      title: appCopy.common.delete, confirmLabel: appCopy.common.delete, destructive: true,
    })) await save(hooks.filter((h) => h.id !== hook.id));
  }
  return <SettingsPage>
    <SettingsSection id="hooks" kind="list"
      state={settings ? (hooks.length ? "ready" : "empty") : failed ? "error" : "loading"}
      emptyMessage={copy.empty} onRetry={() => void refresh()}
      actions={<Button size="sm" disabled={busy} onClick={() => setEditing(emptyHook())}><Plus size="md" />{copy.add}</Button>}>
      <CardList>{hooks.map((hook) => <HookRow key={hook.id} hook={hook} busy={busy}
        onToggle={(enabled) => void save(hooks.map((h) => h.id === hook.id ? { ...h, enabled } : h))}
        onEdit={() => setEditing(hook)} onTest={() => void test(hook)} onRemove={() => void remove(hook)} />)}</CardList>
    </SettingsSection>
    <Dialog open={Boolean(editing)} onOpenChange={(open) => { if (!open && !busy) setEditing(null); }}>
      <DialogContent size="sm" closeLabel={appCopy.common.cancel}>
        <DialogHeader><DialogTitle>{hooks.some((h) => h.id === editing?.id) ? copy.editTitle : copy.add}</DialogTitle></DialogHeader>
        {editing ? <HookForm key={editing.id} hook={editing} busy={busy} onCancel={() => setEditing(null)}
          onSave={(hook) => void save(hooks.some((h) => h.id === hook.id) ? hooks.map((h) => h.id === hook.id ? hook : h) : [...hooks, hook])} /> : null}
      </DialogContent>
    </Dialog>
    <SettingsSection id="hook-runs" kind="list" title={copy.recent} state={runs.length ? "ready" : "empty"}
      emptyMessage={copy.emptyRuns} actions={<Button size="sm" disabled={busy} onClick={() => void refresh()}>{copy.refresh}</Button>}>
      <HookRuns runs={runs} />
    </SettingsSection>
  </SettingsPage>;
}
