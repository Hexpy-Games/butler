import { SettingsField, Textarea } from "@/butler-ds";
import type { PersonalizationDraft, SettingsCopy } from "./settingsTypes";

export function PersonalizationTextFields({
  fields,
  descriptions,
  placeholders,
  personalizationDraft,
  personalizationUpdatedAt,
  setPersonalizationDraft,
}: {
  fields: SettingsCopy["fields"];
  descriptions: SettingsCopy["descriptions"];
  placeholders: SettingsCopy["placeholders"];
  personalizationDraft: PersonalizationDraft;
  personalizationUpdatedAt?: string;
  setPersonalizationDraft: (
    draft:
      | PersonalizationDraft
      | ((current: PersonalizationDraft) => PersonalizationDraft),
  ) => void;
}) {
  return (
    <>
      <SettingsField
        id="personalization-persona"
        settingId="persona"
        data-test-class="settings-field"
        label={fields.persona}
        controlWidth="full"
        control={<Textarea
          id="personalization-persona"
          value={personalizationDraft.persona}
          onChange={(event) =>
            setPersonalizationDraft((current) => ({
              ...current,
              persona: event.target.value,
              personaPreset: "custom",
            }))
          }
          placeholder={placeholders.persona}
          rows={8}
        />}
      />
      <SettingsField
        id="personalization-eol"
        settingId="eol"
        data-test-class="settings-field"
        label={fields.eol}
        controlWidth="full"
        meta={personalizationUpdatedAt
          ? descriptions.eolLastLoaded(new Date(personalizationUpdatedAt).toLocaleString())
          : undefined}
        control={<Textarea
          id="personalization-eol"
          value={personalizationDraft.eol}
          onChange={(event) =>
            setPersonalizationDraft((current) => ({
              ...current,
              eol: event.target.value,
            }))
          }
          placeholder={placeholders.eol}
          rows={8}
        />}
      />
    </>
  );
}
