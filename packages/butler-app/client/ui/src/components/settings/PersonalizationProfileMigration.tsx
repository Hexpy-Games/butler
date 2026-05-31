import { useState } from "react";
import { appCopy } from "@/app/copy.ts";
import {
  profileMigrationFeedbackFromResult,
  type ProfileMigrationFeedback,
} from "@/app/profileMigrationFeedback.ts";
import { useButlerStore } from "@/app/store.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import {
  Button,
  Field,
  FieldLabel,
  SettingsField,
  Stack,
  Textarea,
} from "@/butler-ds";
import { useProfileMigrationPrompt } from "./useProfileMigrationPrompt";

export function PersonalizationProfileMigration() {
  const personalization = useSettingsUIStore((state) => state.personalization);
  const importProfileMigration = useSettingsUIStore(
    (state) => state.importProfileMigration,
  );
  const saving = useSettingsUIStore((state) => state.saving);
  const language = useButlerStore((state) => state.settings.language);
  const [migrationExpanded, setMigrationExpanded] = useState(false);
  const [migrationDump, setMigrationDump] = useState("");
  const [migrationSubmitting, setMigrationSubmitting] = useState(false);
  const [migrationFeedback, setMigrationFeedback] =
    useState<ProfileMigrationFeedback | null>(null);
  const migrationPrompt = useProfileMigrationPrompt(
    migrationExpanded,
    language,
  );

  const settingsCopy = appCopy.settings;
  const settingsFields = settingsCopy.fields;
  const settingsDescriptions = settingsCopy.descriptions;
  const settingsPlaceholders = settingsCopy.placeholders;

  const copyMigrationPrompt = () => {
    if (!migrationPrompt) return;
    void navigator.clipboard?.writeText(migrationPrompt);
  };

  const submitProfileMigration = async () => {
    const text = migrationDump.trim();
    if (!text) return;
    setMigrationSubmitting(true);
    setMigrationFeedback({
      tone: "muted",
      label: settingsDescriptions.profileMigrationImporting,
    });
    try {
      const result = await importProfileMigration(text);
      if (!result) {
        setMigrationFeedback({
          tone: "error",
          label: settingsCopy.errors.profileMigration,
        });
        return;
      }
      setMigrationFeedback(
        profileMigrationFeedbackFromResult(settingsCopy, result),
      );
      if (result.profiling_enabled) setMigrationDump("");
    } finally {
      setMigrationSubmitting(false);
    }
  };

  return (
    <>
      <SettingsField
        data-test-class="settings-field"
        label={settingsFields.profileMigrationImport}
        description={settingsDescriptions.profileMigration}
        meta={
          <span
            aria-live="polite"
            data-test-class="profile-migration-status"
            data-tone={migrationFeedback?.tone ?? "muted"}
            role={migrationFeedback ? "status" : undefined}
          >
            {migrationFeedback?.label ??
              settingsDescriptions.profileMigrationImmediate}
          </span>
        }
        control={
          <Button
            type="button"
            variant="outline"
            aria-expanded={migrationExpanded}
            aria-controls="profile-migration-fields"
            onClick={() => setMigrationExpanded((current) => !current)}
            disabled={saving || !personalization}
          >
            {migrationExpanded
              ? settingsCopy.actions.closeProfileMigration
              : settingsCopy.actions.openProfileMigration}
          </Button>
        }
      />
      {migrationExpanded ? (
        <Stack id="profile-migration-fields" gap="xl">
          <Field data-test-class="settings-field">
            <FieldLabel>{settingsFields.profileMigrationPrompt}</FieldLabel>
            <Textarea value={migrationPrompt} rows={8} readOnly />
            <Stack align="row" justify="end">
              <Button
                type="button"
                variant="outline"
                onClick={copyMigrationPrompt}
                disabled={!migrationPrompt}
              >
                {settingsCopy.actions.copyMigrationPrompt}
              </Button>
            </Stack>
          </Field>
          <Field data-test-class="settings-field">
            <FieldLabel>{settingsFields.profileMigrationDump}</FieldLabel>
            <Textarea
              value={migrationDump}
              onChange={(event) => {
                setMigrationDump(event.target.value);
                if (migrationFeedback) setMigrationFeedback(null);
              }}
              placeholder={settingsPlaceholders.profileMigrationDump}
              rows={8}
              disabled={saving || migrationSubmitting || !personalization}
            />
            <Stack align="row" justify="end">
              <Button
                type="button"
                onClick={submitProfileMigration}
                disabled={
                  saving ||
                  migrationSubmitting ||
                  !personalization ||
                  !migrationDump.trim()
                }
              >
                {migrationSubmitting
                  ? settingsCopy.actions.importProfileMigrationRunning
                  : settingsCopy.actions.importProfileMigration}
              </Button>
            </Stack>
          </Field>
        </Stack>
      ) : null}
    </>
  );
}
