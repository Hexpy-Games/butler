import { Field, FieldLabel, Input } from "@/butler-ds";
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
        <Field key={field.key} data-test-class="settings-field">
          <FieldLabel>{field.label}</FieldLabel>
          <Input
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
          />
        </Field>
      ))}
    </>
  );
}
