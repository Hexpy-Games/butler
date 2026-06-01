import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { runtimeModels } from "@/app/utils.ts";
import {
  personalizationDraftHasChanges,
  useSettingsUIStore,
} from "@/stores/settingsUIStore.ts";
import { SettingsSection, SettingsSelect } from "./SettingsFormComponents";
import {
  personaPresetOptionsFrom,
  profileFieldOptions,
} from "./PersonalizationSettingsOptions";
import { PersonalizationActions } from "./PersonalizationActions";
import { PersonalizationProfileFields } from "./PersonalizationProfileFields";
import { PersonalizationProfileMigration } from "./PersonalizationProfileMigration";
import { PersonalizationProfilingSettings } from "./PersonalizationProfilingSettings";
import { PersonalizationTextFields } from "./PersonalizationTextFields";

export function PersonalizationSettings() {
  const personalization = useSettingsUIStore((state) => state.personalization);
  const personalizationDraft = useSettingsUIStore(
    (state) => state.personalizationDraft,
  );
  const setPersonalizationDraft = useSettingsUIStore(
    (state) => state.setPersonalizationDraft,
  );
  const selectPersonaPreset = useSettingsUIStore(
    (state) => state.selectPersonaPreset,
  );
  const savePersonalization = useSettingsUIStore(
    (state) => state.savePersonalization,
  );
  const saving = useSettingsUIStore((state) => state.saving);
  const modelCatalog = useButlerStore((state) => state.modelCatalog);
  const settings = useButlerStore((state) => state.settings);
  const settingsCopy = appCopy.settings;
  const models = runtimeModels(modelCatalog);
  const settingsFields = settingsCopy.fields;
  const settingsDescriptions = settingsCopy.descriptions;
  const settingsPlaceholders = settingsCopy.placeholders;
  const profileDraft = personalizationDraft.profile;
  const profilingDraft = personalizationDraft.profiling;
  const hasChanges = personalizationDraftHasChanges(
    personalization,
    personalizationDraft,
  );
  const profileFields = profileFieldOptions(
    settingsFields,
    settingsPlaceholders,
  );
  const personaPresetOptions = personaPresetOptionsFrom(
    personalization?.persona_presets ?? [],
    settingsCopy.options.customPersona,
  );
  const responseLanguageOptions = [
    { value: "en", label: settingsCopy.options.english },
    { value: "ko", label: settingsCopy.options.korean },
  ];
  const butlerModel = models.find((item) => item.model_ref === settings.model) ??
    models[0];

  return (
    <SettingsSection title={settingsCopy.sections.personalization}>
      <PersonalizationProfileFields
        fields={profileFields}
        profileDraft={profileDraft}
        saving={saving}
        personalizationLoaded={Boolean(personalization)}
        setPersonalizationDraft={setPersonalizationDraft}
      />
      <SettingsSelect
        label={settingsFields.responseLanguage}
        description={settingsDescriptions.responseLanguage}
        controlWidth="full"
        value={personalizationDraft.responseLanguage}
        onChange={(value) =>
          setPersonalizationDraft((current) => ({
            ...current,
            responseLanguage: value === "ko" ? "ko" : "en",
          }))}
        options={responseLanguageOptions}
        disabled={saving || !personalization}
      />
      <PersonalizationProfilingSettings
        models={models}
        butlerModel={butlerModel}
        profilingDraft={profilingDraft}
        saving={saving}
        personalizationLoaded={Boolean(personalization)}
        setPersonalizationDraft={setPersonalizationDraft}
      />
      <PersonalizationProfileMigration />
      <SettingsSelect
        label={settingsFields.personaPreset}
        description={settingsDescriptions.personaPreset}
        controlWidth="full"
        value={personalizationDraft.personaPreset}
        onChange={selectPersonaPreset}
        options={personaPresetOptions}
        disabled={saving || !personalization}
      />
      <PersonalizationTextFields
        fields={settingsFields}
        descriptions={settingsDescriptions}
        placeholders={settingsPlaceholders}
        personalizationDraft={personalizationDraft}
        personalizationUpdatedAt={personalization?.updated_at}
        setPersonalizationDraft={setPersonalizationDraft}
      />
      <PersonalizationActions
        saving={saving}
        personalizationLoaded={Boolean(personalization)}
        clearProfileQueued={profilingDraft.clearProfile}
        hasChanges={hasChanges}
        setPersonalizationDraft={setPersonalizationDraft}
        onSave={savePersonalization}
      />
    </SettingsSection>
  );
}
