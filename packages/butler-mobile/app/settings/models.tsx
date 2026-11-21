import { useEffect, useState } from "react";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { useConversation } from "@/conversation/live";
import { ListGroup, showToast } from "@/ds";
import { useAppLocale } from "@/i18n";
import { SettingsScreen, LoadState } from "@/settings/layout";
import { ReasoningRow, SelectRow } from "@/settings/rows";
import { useSettings } from "@/settings/useSettings";
import { modelLabel, runtimeModels, useModelCatalog } from "@/settings/useModelCatalog";
import type { AppModelSummary, ModelCatalogView, SettingsView } from "@/settings/types";

type SettingsProps = { settings: SettingsView; update: ReturnType<typeof useSettings>["update"] };

export default function ModelsSettings() {
  const S = getAppCopy(useAppLocale()).settings;
  const { settings, update, error, reload } = useSettings();
  const catalogState = useModelCatalog();
  return <SettingsScreen title={S.sections.models}>
    {!settings || !catalogState.catalog ? <ListGroup><LoadState error={error || catalogState.error} onRetry={() => { reload(); catalogState.reload(); }} /></ListGroup> : <>
      <ButlerModel settings={settings} update={update} models={runtimeModels(catalogState.catalog)} catalog={catalogState.catalog} />
      <ImageModels />
    </>}
  </SettingsScreen>;
}

function ButlerModel({ settings, update, models, catalog }: SettingsProps & { models: AppModelSummary[]; catalog: ModelCatalogView }) {
  const locale = useAppLocale();
  const S = getAppCopy(locale).settings;
  const activeModel = models.find(model => model.model_ref === settings.model) ?? models[0];
  const max = activeModel?.context_window_tokens ?? 200_000;
  const choose = (model: string) => {
    const nextModel = models.find(item => item.model_ref === model);
    const nextMax = nextModel?.context_window_tokens ?? settings.context_window_tokens;
    void update({ model, reasoning_effort: nextModel?.reasoning_efforts?.includes(settings.reasoning_effort)
      && !(nextModel.provider_id === "local" && nextModel.local_reasoning_budget_ratio && settings.reasoning_effort === "none")
      ? settings.reasoning_effort : (nextModel?.default_reasoning_effort ?? "medium"),
    context_window_tokens: settings.context_window_tokens >= max ? nextMax ?? max : Math.min(settings.context_window_tokens, nextMax ?? max) });
  };
  return <ListGroup label={S.pageSections.butlerModel}>
    <SelectRow title={S.fields.butlerModel}
      value={activeModel?.model_ref ?? catalog.default_model_ref} options={models.map(m => ({ value: m.model_ref, label: modelLabel(m, locale) }))} onSelect={choose} />
    <ReasoningRow title={S.fields.butlerReasoning} model={activeModel} value={settings.reasoning_effort}
      onSelect={reasoning_effort => { void update({ reasoning_effort }); }} />
  </ListGroup>;
}

type ImageSelection = { model_ref: string; credential_id: string | null; default_quality: string | null };
type ImageSettings = { selected: ImageSelection | null; registered: string[]; models: (ImageSelection & {
  display_name: string; provider_id: string; provider_label: string; qualities: string[];
})[] };

function ImageModels() {
  const app = getAppCopy(useAppLocale());
  const copy = app.conversation.imageTools;
  const { client } = useConversation();
  const [settings, setSettings] = useState<ImageSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const reload = () => {
    if (!client) return;
    setError(false);
    void client.request<ImageSettings>("/settings/image-model").then(setSettings).catch(() => setError(true));
  };
  useEffect(reload, [client]);
  const save = async (selection: ImageSelection | null) => {
    if (!client) return;
    setBusy(true);
    try { setSettings(await client.request<ImageSettings>("/settings/image-model", { method: "PUT", body: selection ?? { selected: null } })); }
    catch { showToast({ message: app.settings.errors.saveFailed, tone: "error" }); }
    finally { setBusy(false); }
  };
  return <ListGroup label={app.settings.pageSections.imageModels}>
    {!settings ? <LoadState error={error} onRetry={reload} />
      : <SelectRow title={copy.model} value={settings.selected?.model_ref ?? "off"} disabled={busy}
        options={[{ value: "off", label: copy.off }, ...settings.models.filter(m => settings.registered.includes(m.model_ref)).map(m => ({
          value: m.model_ref, label: m.display_name, description: m.provider_id === "custom-image" ? copy.custom : m.provider_label,
        }))]} onSelect={ref => {
          if (ref === "off") { void save(null); return; }
          const next = settings.models.find(m => m.model_ref === ref);
          if (next) void save({ model_ref: ref, credential_id: next.credential_id, default_quality: next.default_quality });
        }} />}
  </ListGroup>;
}
