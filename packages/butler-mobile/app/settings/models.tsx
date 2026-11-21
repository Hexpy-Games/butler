import { useEffect, useState } from "react";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { useConversation } from "@/conversation/live";
import { ListGroup, ListGroupItem, Button, Icon, icons, ListRow, Sheet, Text, TextField, showToast } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";
import { SettingsScreen, LoadState } from "@/settings/layout";
import { ReasoningRow, SelectRow, SwitchRow } from "@/settings/rows";
import { useSettings } from "@/settings/useSettings";
import { modelDisplayName, modelLabel, runtimeModels, tokenWindowLabel, useModelCatalog } from "@/settings/useModelCatalog";
import { MAX_BACKUP_MODELS, moveBackupModel, selectableBackupModels } from "@/settings/backupModelsUtils";
import type { AppModelSummary, ModelCatalogView, SettingsView } from "@/settings/types";

type SettingsProps = { settings: SettingsView; update: ReturnType<typeof useSettings>["update"] };

export default function ModelsSettings() {
  const S = getAppCopy(useAppLocale()).settings;
  const { settings, update, error, reload } = useSettings();
  const catalogState = useModelCatalog();
  return <SettingsScreen title={S.sections.models} description={S.sectionDescriptions.models}>
    {!settings || !catalogState.catalog ? <ListGroup><LoadState error={error || catalogState.error} onRetry={() => { reload(); catalogState.reload(); }} /></ListGroup> : <>
      <ButlerModel settings={settings} update={update} models={runtimeModels(catalogState.catalog)} catalog={catalogState.catalog} />
      <BackupModels settings={settings} update={update} catalog={catalogState.catalog} />
      <ImageModels />
      <ListGroup label={S.modelsAdvanced.title}>
        <SelectRow title={S.workerProfilesPanel.maxSimultaneousWorkers} value={String(settings.max_simultaneous_workers)}
          options={Array.from({ length: 10 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))}
          onSelect={value => { void update({ max_simultaneous_workers: Number(value) }); }} />
      </ListGroup>
    </>}
  </SettingsScreen>;
}

function ButlerModel({ settings, update, models, catalog }: SettingsProps & { models: AppModelSummary[]; catalog: ModelCatalogView }) {
  const locale = useAppLocale();
  const app = getAppCopy(locale);
  const S = app.settings;
  const M = useMobileCopy();
  const activeModel = models.find(model => model.model_ref === settings.model) ?? models[0];
  const max = activeModel?.context_window_tokens ?? 200_000;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const choose = (model: string) => {
    const nextModel = models.find(item => item.model_ref === model);
    const nextMax = nextModel?.context_window_tokens ?? settings.context_window_tokens;
    void update({ model, reasoning_effort: nextModel?.reasoning_efforts?.includes(settings.reasoning_effort)
      && !(nextModel.provider_id === "local" && nextModel.local_reasoning_budget_ratio && settings.reasoning_effort === "none")
      ? settings.reasoning_effort : (nextModel?.default_reasoning_effort ?? "medium"),
    context_window_tokens: settings.context_window_tokens >= max ? nextMax ?? max : Math.min(settings.context_window_tokens, nextMax ?? max) });
  };
  const saveContext = async () => {
    const value = Math.max(1000, Math.min(max, Number(text)));
    setOpen(false);
    if (await update({ context_window_tokens: value }) && value !== Number(text)) {
      showToast({ message: S.descriptions.contextLimitClamped(value.toLocaleString("en-US")) });
    }
  };
  return <ListGroup label={S.pageSections.butlerModel}>
    <SelectRow title={S.fields.butlerModel} description={S.descriptions.runtimeSupportedModelsOnly}
      value={activeModel?.model_ref ?? catalog.default_model_ref} options={models.map(m => ({ value: m.model_ref, label: modelLabel(m, locale) }))} onSelect={choose} />
    <ReasoningRow title={S.fields.butlerReasoning} model={activeModel} value={settings.reasoning_effort}
      onSelect={reasoning_effort => { void update({ reasoning_effort }); }} />
    <ListRow title={S.fields.contextLimit} description={S.descriptions.contextLimit(tokenWindowLabel(max, locale))}
      meta={settings.context_window_tokens.toLocaleString(locale)} trailing={<Icon glyph={icons.ChevronRight} size="lg" tone="tertiary" />}
      onPress={() => { setText(String(settings.context_window_tokens)); setOpen(true); }} />
    <Sheet open={open} onClose={() => setOpen(false)} title={S.fields.contextLimit} cancelLabel={M.settings.cancel}
      action={<Button label={app.common.save} disabled={!/^\d+$/.test(text)} onPress={() => { void saveContext(); }} />}>
      <TextField label={S.fields.contextLimit} keyboardType="number-pad" value={text} onChangeText={setText} />
    </Sheet>
  </ListGroup>;
}

function BackupModels({ settings, update, catalog }: SettingsProps & { catalog: ModelCatalogView }) {
  const locale = useAppLocale();
  const app = getAppCopy(locale);
  const S = app.settings;
  const M = useMobileCopy();
  const fallback = settings.model_fallback;
  const registered = (catalog.registered_models ?? []).filter(m => m.registered === true && m.runtime_supported === true);
  const [selected, setSelected] = useState<AppModelSummary | null>(null);
  const [adding, setAdding] = useState(false);
  const index = selected ? fallback.models.indexOf(selected.model_ref) : -1;
  const candidates = selectableBackupModels(registered, settings.model, fallback.models);
  const save = (models: string[]) => { setSelected(null); setAdding(false); void update({ model_fallback: { enabled: fallback.enabled, models } }); };
  const cards = fallback.models.flatMap(ref => { const model = registered.find(m => m.model_ref === ref); return model ? [model] : []; });
  return <ListGroup label={S.pageSections.backupModels} footer={fallback.enabled ? S.backupModels.description : undefined}>
    <SwitchRow title={S.backupModels.enabled} description={S.backupModels.enabledDescription} value={fallback.enabled}
      onChange={enabled => { void update({ model_fallback: { enabled, models: fallback.models } }); }} />
    {fallback.enabled ? <>
      {cards.map(m => <ListRow key={m.model_ref} title={modelDisplayName(m, locale)} description={`${m.provider_label} · ${m.model_ref}`}
        meta={tokenWindowLabel(m.context_window_tokens, locale)} onPress={() => setSelected(m)} />)}
      {cards.length === 0 ? <ListGroupItem><Text variant="caption">{S.backupModels.empty}</Text></ListGroupItem> : null}
      <ListRow icon={icons.Plus} title={S.backupModels.add} disabled={fallback.models.length >= MAX_BACKUP_MODELS}
        meta={fallback.models.length >= MAX_BACKUP_MODELS ? S.backupModels.limitReached : undefined} onPress={() => setAdding(true)} />
    </> : null}
    <Sheet open={!!selected} onClose={() => setSelected(null)} title={modelDisplayName(selected, locale)} cancelLabel={M.settings.cancel}>
      <ListRow title={M.settings.moveUp} disabled={index <= 0} onPress={() => save(moveBackupModel(fallback.models, index, -1))} />
      <ListRow title={M.settings.moveDown} disabled={index >= fallback.models.length - 1} onPress={() => save(moveBackupModel(fallback.models, index, 1))} />
      <ListRow title={app.common.delete} onPress={() => save(fallback.models.filter(ref => ref !== selected?.model_ref))} />
    </Sheet>
    <Sheet open={adding} onClose={() => setAdding(false)} title={S.backupModels.addTitle} cancelLabel={M.settings.cancel}>
      {candidates.map(m => <ListRow key={m.model_ref} title={modelDisplayName(m, locale)} description={`${m.provider_label} · ${tokenWindowLabel(m.context_window_tokens, locale)}`}
        onPress={() => save([...fallback.models, m.model_ref])} />)}
      {candidates.length === 0 ? <Text variant="caption">{S.backupModels.noCandidates}</Text> : null}
    </Sheet>
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
  const selected = settings?.selected;
  const model = settings?.models.find(m => m.model_ref === selected?.model_ref);
  return <ListGroup label={app.settings.pageSections.imageModels}>
    {!settings ? <LoadState error={error} onRetry={reload} /> : <>
      <SelectRow title={copy.model} value={selected?.model_ref ?? "off"} disabled={busy}
        options={[{ value: "off", label: copy.off }, ...settings.models.filter(m => settings.registered.includes(m.model_ref)).map(m => ({
          value: m.model_ref, label: m.display_name, description: m.provider_id === "custom-image" ? copy.custom : m.provider_label,
        }))]} onSelect={ref => {
          if (ref === "off") { void save(null); return; }
          const next = settings.models.find(m => m.model_ref === ref);
          if (next) void save({ model_ref: ref, credential_id: next.credential_id, default_quality: next.default_quality });
        }} />
      {model && model.qualities.length > 0 ? <SelectRow title={copy.defaultQuality} value={selected?.default_quality ?? model.default_quality ?? ""} disabled={busy}
        options={model.qualities.map(value => ({ value, label: copy.quality[value as keyof typeof copy.quality] ?? value }))}
        onSelect={default_quality => { void save({ model_ref: model.model_ref, credential_id: selected!.credential_id, default_quality }); }} /> : null}
    </>}
  </ListGroup>;
}
