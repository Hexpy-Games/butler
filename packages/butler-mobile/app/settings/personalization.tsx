import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { useConversation } from "@/conversation/live";
import { Button, ListGroup, ListGroupItem, TextField, showToast } from "@/ds";
import { useAppLocale } from "@/i18n";
import { SettingsScreen, LoadState } from "@/settings/layout";
import { SelectRow } from "@/settings/rows";
import { draftFromPersonalization, personalizationDraftHasChanges, personalizationUpdatePayload, selectPersonaPreset, type PersonalizationDraft } from "@/settings/personalization";
import type { PersonalizationView } from "@/settings/types";

type DraftProps = { draft: PersonalizationDraft; setDraft: Dispatch<SetStateAction<PersonalizationDraft | null>>; saving: boolean };

export default function PersonalizationSettings() {
  const S = getAppCopy(useAppLocale()).settings;
  const { client, reconcile, subscribe } = useConversation();
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
  return <SettingsScreen title={S.sections.personalization}>
    {!personalization || !draft
      ? <ListGroup><LoadState error={error} onRetry={reload} /></ListGroup>
      : <>
        <ProfileFields draft={draft} setDraft={setDraft} saving={saving} />
        <ResponseStyle draft={draft} setDraft={setDraft} saving={saving} personalization={personalization} />
        <Learning draft={draft} setDraft={setDraft} saving={saving} />
        <ListGroup><ListGroupItem>
          <Button label={S.actions.applyPersonalization} disabled={saving || !hasChanges} loading={saving} onPress={() => { void save(); }} />
        </ListGroupItem></ListGroup>
      </>}
  </SettingsScreen>;
}

function ProfileFields({ draft, setDraft, saving }: DraftProps) {
  const S = getAppCopy(useAppLocale()).settings;
  return <ListGroup label={S.pageSections.profile}>
    {([
      ["butler_nickname", "butlerNickname"], ["principal_name", "principalName"], ["preferred_address", "preferredAddress"],
    ] as const).map(([key, copy]) => <ListGroupItem key={key}><TextField label={S.fields[copy]} placeholder={S.placeholders[copy]} value={draft.profile[key]} disabled={saving}
      onChangeText={text => setDraft(current => current && ({ ...current, profile: { ...current.profile, [key]: text } }))} /></ListGroupItem>)}
  </ListGroup>;
}

function ResponseStyle({ draft, setDraft, saving, personalization }: DraftProps & { personalization: PersonalizationView }) {
  const S = getAppCopy(useAppLocale()).settings;
  return <ListGroup label={S.pageSections.responseStyle}>
    <SelectRow title={S.fields.responseLanguage} value={draft.responseLanguage} disabled={saving}
      options={[{ value: "en", label: S.options.english }, { value: "ko", label: S.options.korean }]}
      onSelect={responseLanguage => setDraft(current => current && ({ ...current, responseLanguage }))} />
    <SelectRow title={S.fields.personaPreset} value={draft.personaPreset} disabled={saving}
      options={[{ value: "custom", label: S.options.customPersona }, ...personalization.persona_presets.map(p => ({ value: p.name, label: p.label, description: p.preview }))]}
      onSelect={preset => setDraft(current => current && selectPersonaPreset(current, personalization, preset))} />
  </ListGroup>;
}

function Learning({ draft, setDraft, saving }: DraftProps) {
  const S = getAppCopy(useAppLocale()).settings;
  return <ListGroup label={S.pageSections.learning}>
    <SelectRow title={S.fields.profilingMode} value={draft.profiling.mode} disabled={saving}
      options={([
        ["off", "profilingOff"], ["basic", "profilingBasic"], ["deep", "profilingDeep"],
      ] as const).map(([value, key]) => ({ value, label: S.options[key], description: S.descriptions[key] }))}
      onSelect={mode => setDraft(current => current && ({ ...current, profiling: { ...current.profiling, mode } }))} />
  </ListGroup>;
}
