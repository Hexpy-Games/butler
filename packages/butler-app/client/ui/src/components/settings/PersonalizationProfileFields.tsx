import { Input, SettingsField } from "@/butler-ds";
import type { ProfileFieldKey } from "./PersonalizationSettingsOptions";
import type { PersonalizationDraft } from "./settingsTypes";

interface PersonalizationProfileFieldsProps {
  fields: Array<{ key: ProfileFieldKey; label: string; placeholder: string }>;
  profileDraft: PersonalizationDraft["profile"];
  saving: boolean;
  personalizationLoaded: boolean;
  setPersonalizationDraft: (
    draft:
      | PersonalizationDraft
      | ((current: PersonalizationDraft) => PersonalizationDraft),
  ) => void;
}

export function PersonalizationProfileFields({
  fields,
  profileDraft,
  saving,
  personalizationLoaded,
  setPersonalizationDraft,
}: PersonalizationProfileFieldsProps) {
  return (
    <>
      {fields.map((field) => (
        <SettingsField
          key={field.key}
          id={`personalization-profile-${field.key}`}
          settingId={field.key.replace(/_/gu, "-")}
          data-test-class="settings-field"
          label={field.label}
          control={<Input
            id={`personalization-profile-${field.key}`}
            value={profileDraft[field.key]}
            onChange={(event) =>
              setPersonalizationDraft((current) => ({
                ...current,
                profile: {
                  ...current.profile,
                  [field.key]: event.target.value,
                },
              }))
            }
            placeholder={field.placeholder}
            disabled={saving || !personalizationLoaded}
          />}
        />
      ))}
    </>
  );
}
