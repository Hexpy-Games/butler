import { Field, FieldDescription, FieldLabel, Textarea } from "@/butler-ds";
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
      <Field data-test-class="settings-field">
        <FieldLabel>{fields.persona}</FieldLabel>
        <Textarea
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
        />
      </Field>
      <Field data-test-class="settings-field">
        <FieldLabel>{fields.eol}</FieldLabel>
        <Textarea
          value={personalizationDraft.eol}
          onChange={(event) =>
            setPersonalizationDraft((current) => ({
              ...current,
              eol: event.target.value,
            }))
          }
          placeholder={placeholders.eol}
          rows={8}
        />
        {personalizationUpdatedAt && (
          <FieldDescription>
            {descriptions.eolLastLoaded(
              new Date(personalizationUpdatedAt).toLocaleString(),
            )}
          </FieldDescription>
        )}
      </Field>
    </>
  );
}
