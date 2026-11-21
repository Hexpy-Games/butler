import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { useConversation } from "@/conversation/live";
import { Button, ListRow, Text, TextField, showToast, useTokens } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";
import { GroupInset, SettingsScreen, SettingsGroup, LoadState } from "@/settings/layout";
import { ReasoningRow, SelectRow } from "@/settings/rows";
import { useSettings } from "@/settings/useSettings";
import { modelLabel, runtimeModels, useModelCatalog } from "@/settings/useModelCatalog";
import { draftFromPersonalization, personalizationDraftHasChanges, personalizationUpdatePayload, selectPersonaPreset, type PersonalizationDraft } from "@/settings/personalization";
import type { AppModelSummary, PersonalizationView, PersonalizationProfileMigrationPromptView, PersonalizationProfileMigrationResultView } from "@/settings/types";

type DraftProps = { draft: PersonalizationDraft; setDraft: Dispatch<SetStateAction<PersonalizationDraft | null>>; saving: boolean };

export default function PersonalizationSettings() {
  const S = getAppCopy(useAppLocale()).settings;
  const t = useTokens();
  const { client, reconcile, subscribe } = useConversation();
  const settingsState = useSettings();
  const catalogState = useModelCatalog();
  const [personalization, setPersonalization] = useState<PersonalizationView | null>(null);
  const [draft, setDraft] = useState<PersonalizationDraft | null>(null);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const hasChanges = !!draft && personalizationDraftHasChanges(personalization, draft);
  const dirty = useRef(hasChanges);
  dirty.current = hasChanges;
  const replace = (view: PersonalizationView) => { setPersonalization(view); setDraft(draftFromPersonalization(view)); };
  const reload = useCallback(() => {
    if (!client || dirty.current) return;
    setError(false);
    void client.request<PersonalizationView>("/personalization").then(view => {
      if (!dirty.current) { setPersonalization(view); setDraft(draftFromPersonalization(view)); }
    }).catch(() => { setError(true); showToast({ message: S.errors.loadPersonalization, tone: "error" }); });
  }, [client, S]);
  useEffect(reload, [reload, reconcile]);
  useEffect(() => subscribe(event => { if (event.type === "personalization.updated") reload(); }), [subscribe, reload]);
  const save = async () => {
    if (!client || !draft) return;
    setSaving(true);
    try {
      replace(await client.request<PersonalizationView>("/personalization", { method: "PATCH", body: personalizationUpdatePayload(personalization, draft) }));
      showToast({ message: S.saved, tone: "success" });
    } catch { showToast({ message: S.errors.updatePersonalization, tone: "error" }); }
    finally { setSaving(false); }
  };
  const models = catalogState.catalog ? runtimeModels(catalogState.catalog) : [];
  const butlerModel = models.find(m => m.model_ref === settingsState.settings?.model) ?? models[0];
  return <SettingsScreen title={S.sections.personalization} description={S.sectionDescriptions.personalization}>
    {!personalization || !draft || !settingsState.settings || !catalogState.catalog
      ? <LoadState error={error || settingsState.error || catalogState.error} onRetry={() => { reload(); settingsState.reload(); catalogState.reload(); }} />
      : <>
        <ProfileFields draft={draft} setDraft={setDraft} saving={saving} />
        <ResponseStyle draft={draft} setDraft={setDraft} saving={saving} personalization={personalization} />
        <Learning draft={draft} setDraft={setDraft} saving={saving} models={models} butlerModel={butlerModel} />
        <ProfileImport language={settingsState.settings.language} replace={replace} />
        <View style={{ paddingHorizontal: t.length("--adaptive-page-gutter") }}>
          <Button label={S.actions.applyPersonalization} disabled={saving || !hasChanges} loading={saving} onPress={() => { void save(); }} />
        </View>
      </>}
  </SettingsScreen>;
}

function ProfileFields({ draft, setDraft, saving }: DraftProps) {
  const S = getAppCopy(useAppLocale()).settings;
  return <SettingsGroup title={S.pageSections.profile}>
    {([
      ["butler_nickname", "butlerNickname"], ["principal_name", "principalName"], ["preferred_address", "preferredAddress"],
    ] as const).map(([key, copy]) => <GroupInset key={key}><TextField label={S.fields[copy]} placeholder={S.placeholders[copy]} value={draft.profile[key]} disabled={saving}
      onChangeText={text => setDraft(current => current && ({ ...current, profile: { ...current.profile, [key]: text } }))} /></GroupInset>)}
  </SettingsGroup>;
}

function ResponseStyle({ draft, setDraft, saving, personalization }: DraftProps & { personalization: PersonalizationView }) {
  const S = getAppCopy(useAppLocale()).settings;
  const M = useMobileCopy();
  return <SettingsGroup title={S.pageSections.responseStyle}>
    <SelectRow title={S.fields.responseLanguage} description={S.descriptions.responseLanguage} value={draft.responseLanguage} disabled={saving}
      options={[{ value: "en", label: S.options.english }, { value: "ko", label: S.options.korean }]}
      onSelect={responseLanguage => setDraft(current => current && ({ ...current, responseLanguage }))} />
    <SelectRow title={S.fields.personaPreset} description={S.descriptions.personaPreset} value={draft.personaPreset} disabled={saving}
      options={[{ value: "custom", label: S.options.customPersona }, ...personalization.persona_presets.map(p => ({ value: p.name, label: p.label, description: p.preview }))]}
      onSelect={preset => setDraft(current => current && selectPersonaPreset(current, personalization, preset))} />
    <ListRow title={S.fields.persona} description={draft.persona || S.placeholders.persona} descriptionLines={3} />
    <ListRow title={S.fields.eol} description={draft.eol || S.placeholders.eol} descriptionLines={3}
      meta={S.descriptions.eolLastLoaded(new Date(personalization.updated_at).toLocaleString())} />
    <GroupInset><Text variant="caption" tone="secondary">{M.settings.editOnComputer}</Text></GroupInset>
  </SettingsGroup>;
}

function Learning({ draft, setDraft, saving, models, butlerModel }: DraftProps & { models: AppModelSummary[]; butlerModel?: AppModelSummary }) {
  const locale = useAppLocale();
  const S = getAppCopy(locale).settings;
  const profiling = draft.profiling;
  const model = profiling.extractorModel === "default" ? butlerModel : models.find(m => m.model_ref === profiling.extractorModel) ?? butlerModel;
  return <SettingsGroup title={S.pageSections.learning} description={S.pageSectionDescriptions.learning}>
    <SelectRow title={S.fields.profilingMode} description={S.descriptions.profilingMode} value={profiling.mode} disabled={saving}
      options={([
        ["off", "profilingOff"], ["basic", "profilingBasic"], ["deep", "profilingDeep"],
      ] as const).map(([value, key]) => ({ value, label: S.options[key], description: S.descriptions[key] }))}
      onSelect={mode => setDraft(current => current && ({ ...current, profiling: { ...current.profiling, mode } }))} />
    <SelectRow title={S.fields.profilingExtractorModel} description={S.descriptions.profilingExtractorModel} value={profiling.extractorModel} disabled={saving}
      options={[{ value: "default", label: S.options.profilingExtractorDefault, description: S.descriptions.profilingExtractorDefault },
        ...models.map(m => ({ value: m.model_ref, label: modelLabel(m, locale) }))]}
      onSelect={extractorModel => setDraft(current => current && ({ ...current, profiling: { ...current.profiling, extractorModel } }))} />
    <ReasoningRow title={S.fields.reasoning} model={model} value={profiling.extractorReasoningEffort}
      onSelect={extractorReasoningEffort => setDraft(current => current && ({ ...current, profiling: { ...current.profiling, extractorReasoningEffort } }))} />
    <ListRow title={S.memory.linkLabel} description={S.memory.linkDescription} onPress={() => router.push("/settings/memory")} />
  </SettingsGroup>;
}

function ProfileImport({ language, replace }: { language: string; replace(view: PersonalizationView): void }) {
  const S = getAppCopy(useAppLocale()).settings;
  const M = useMobileCopy();
  const { client } = useConversation();
  const [running, setRunning] = useState(false);
  const copyPrompt = async () => {
    if (!client) return;
    try {
      const { prompt } = await client.request<PersonalizationProfileMigrationPromptView>(`/personalization/profile-import-prompt?locale=${language === "ko" ? "ko" : "en"}`);
      await Clipboard.setStringAsync(prompt);
      showToast({ message: M.chat.copied, tone: "success" });
    } catch { showToast({ message: S.errors.profileMigration, tone: "error" }); }
  };
  const importProfile = async () => {
    if (!client) return;
    setRunning(true);
    try {
      const text = (await Clipboard.getStringAsync()).trim();
      if (!text) { showToast({ message: M.settings.clipboardEmpty, tone: "warning" }); return; }
      const result = await client.request<PersonalizationProfileMigrationResultView>("/personalization/profile-import", { method: "POST", body: { text } });
      replace(result.personalization);
      if (!result.profiling_enabled) showToast({ message: S.errors.profileMigrationProfilingOff, tone: "warning" });
      else if (result.promoted_count > 0) showToast({ message: S.descriptions.profileMigrationApplied(result.promoted_count), tone: "success" });
      else showToast({ message: result.imported_candidate_count > 0 ? S.descriptions.profileMigrationStored : S.descriptions.profileMigrationNoNewInfo, tone: "neutral" });
    } catch { showToast({ message: S.errors.profileMigration, tone: "error" }); }
    finally { setRunning(false); }
  };
  return <SettingsGroup title={S.pageSections.agentImport}>
    <ListRow title={S.fields.profileMigrationImport} description={S.descriptions.profileMigration} />
    <GroupInset><Button variant="secondary" label={S.actions.copyMigrationPrompt} onPress={() => { void copyPrompt(); }} /></GroupInset>
    <GroupInset><Button label={running ? S.actions.importProfileMigrationRunning : S.actions.importProfileMigration} disabled={running} loading={running} onPress={() => { void importProfile(); }} /></GroupInset>
    <GroupInset><Text variant="caption" tone="secondary">{M.settings.importFromClipboardHint}</Text></GroupInset>
  </SettingsGroup>;
}
