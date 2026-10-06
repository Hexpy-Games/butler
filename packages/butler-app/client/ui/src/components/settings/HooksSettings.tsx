import { useEffect, useState } from "react";
import { api } from "@/app/api.ts";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import { Button, ButtonContainer, CardList, CardListItem, DisclosureRow, Switch, Textarea } from "@/butler-ds";
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
  const [expanded, setExpanded] = useState<number | null>(null);
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
      notifyStatus(`${run.outcome} · ${run.duration_ms} ms`);
      await refresh();
    } catch (error) { notifyError(error, appCopy.interfaceFeedback.requestFailed); }
    finally { setBusy(false); }
  }
  const hooks = settings?.config.hooks ?? [];
  return <SettingsPage>
    <SettingsSection id="hooks" kind="list" title={copy.user}
      state={settings ? (hooks.length ? "ready" : "empty") : failed ? "error" : "loading"}
      emptyMessage={copy.empty} onRetry={() => void refresh()}
      actions={<Button size="sm" disabled={busy} onClick={() => setEditing(emptyHook())}>{copy.add}</Button>}>
      <CardList>{hooks.map((hook) => <CardListItem key={hook.id} title={hook.name || hook.id}
        description={[hook.event, hook.match.tools.join(", "), hook.command ?? hook.args?.join(" ")].filter(Boolean).join(" · ")}
        actions={<ButtonContainer size="xs">
          <Switch aria-label={`${hook.name || hook.id}: ${copy.enabled}`} checked={hook.enabled} disabled={busy}
            onCheckedChange={(enabled) => void save(hooks.map((h) => h.id === hook.id ? { ...h, enabled } : h))} />
          <Button size="xs" variant="outline" disabled={busy} onClick={() => setEditing(hook)}>{copy.edit}</Button>
          <Button size="xs" variant="outline" disabled={busy} onClick={() => void test(hook)}>{copy.test}</Button>
          <Button size="xs" variant="outline" disabled={busy} onClick={() => void save(hooks.filter((h) => h.id !== hook.id))}>{copy.remove}</Button>
        </ButtonContainer>} />)}</CardList>
    </SettingsSection>
    {editing ? <SettingsSection id="hook-form" kind="form" title={copy.edit}>
      <HookForm key={editing.id} hook={editing} busy={busy} onCancel={() => setEditing(null)}
        onSave={(hook) => void save(hooks.some((h) => h.id === hook.id) ? hooks.map((h) => h.id === hook.id ? hook : h) : [...hooks, hook])} />
    </SettingsSection> : null}
    <SettingsSection id="hook-runs" kind="list" title={copy.recent} state={runs.length ? "ready" : "empty"}
      emptyMessage={copy.empty} actions={<Button size="sm" disabled={busy} onClick={() => void refresh()}>{copy.refresh}</Button>}>
      <CardList>{[...runs].reverse().map((run, index) => <DisclosureRow key={`${run.time}-${index}`}
        title={`${run.hook_id} · ${run.event} · ${run.outcome}`} open={expanded === index}
        onToggle={() => setExpanded(expanded === index ? null : index)}
        description={`${run.time} · ${run.session_id ?? ""} · ${run.duration_ms} ms · ${run.exit_code ?? "—"}`}>
        <Textarea readOnly rows={6} aria-label={run.hook_id}
          value={[run.reason, run.stdout, run.stderr].filter(Boolean).join("\n")} />
      </DisclosureRow>)}</CardList>
    </SettingsSection>
  </SettingsPage>;
}
