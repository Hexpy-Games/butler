import { useState } from "react";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { useConversation } from "@/conversation/live";
import { Button, ListRow, Sheet, showToast } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";
import { LoadState, SettingsGroup, SettingsScreen } from "@/settings/layout";
import { SelectRow, SwitchRow } from "@/settings/rows";
import { useSettings } from "@/settings/useSettings";
import { useModelCatalog } from "@/settings/useModelCatalog";

export default function BrowserSettings() {
  const app = getAppCopy(useAppLocale()), S = app.settings, M = useMobileCopy();
  const { settings, update, error, reload } = useSettings(), catalog = useModelCatalog();
  const models = (catalog.catalog?.registered_models ?? []).filter(m => m.runtime_supported && m.enabled !== false);
  const auto = settings?.browser?.auto;
  const autoModel = models.find(m => m.model_ref === auto?.model) ?? catalog.catalog?.models.find(m => m.model_ref === auto?.model);
  const autoName = auto?.available ? autoModel?.display_name ?? S.browsingAgent.conversationModel : S.browsingAgent.conversationModel;
  return <SettingsScreen title={S.sections.browser} description={S.sectionDescriptions.browser}>
    {!settings || !catalog.catalog ? <LoadState error={error || catalog.error} onRetry={() => { reload(); catalog.reload(); }} /> : <>
      <SettingsGroup title={S.pageSections.browsing}>
        <SelectRow title={S.browsingAgent.label} value={settings.browser?.browsing_agent ?? "auto"}
          options={[{ value: "auto", label: S.browsingAgent.auto(autoName) }, { value: "off", label: S.browsingAgent.off }, ...models.map(m => ({ value: m.model_ref, label: m.display_name }))]}
          onSelect={browsing_agent => void update({ browser: { browsing_agent } })} />
      </SettingsGroup>
    </>}
    <HistoryGroup cancelLabel={M.settings.cancel} />
  </SettingsScreen>;
}

function HistoryGroup({ cancelLabel }: { cancelLabel: string }) {
  const app = getAppCopy(useAppLocale()), history = app.browser.history;
  const { client } = useConversation();
  const [open, setOpen] = useState(false), [range, setRange] = useState("hour"), [butlerOnly, setOnly] = useState(false), [busy, setBusy] = useState(false);
  const clear = async () => {
    if (!client || busy) return;
    setBusy(true);
    try { await client.request("/browser-history/clear", { method: "POST", body: { range, butlerOnly } }); setOpen(false); }
    catch { showToast({ message: app.browser.failed, tone: "error" }); }
    finally { setBusy(false); }
  };
  return <SettingsGroup title={history.title}>
    <ListRow title={history.pageLabel} description={history.pageDescription} trailing={<Button label={history.erase} onPress={() => { setRange("hour"); setOnly(false); setOpen(true); }} />} />
    <Sheet open={open} onClose={() => { if (!busy) setOpen(false); }} title={history.clear} cancelLabel={cancelLabel}
      action={<Button variant="destructive" label={app.browser.remove} loading={busy} onPress={() => void clear()} />}>
      {(["hour", "today", "week", "all"] as const).map(value => <ListRow key={value} title={history[value]} selected={range === value} disabled={busy} onPress={() => setRange(value)} />)}
      <SwitchRow title={history.butlerOnly} value={butlerOnly} disabled={busy} onChange={setOnly} />
    </Sheet>
  </SettingsGroup>;
}
