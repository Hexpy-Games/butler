import { useAppLocale } from "@/app/copy.ts";
import { useState } from "react";
import { appCopy } from "@/app/copy.ts";
import {
  profileMigrationFeedbackFromResult,
  type ProfileMigrationFeedback,
} from "@/app/profileMigrationFeedback.ts";
import { useButlerStore } from "@/app/store.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { Button, ListRow, SettingsField, Sparkles, Stack, Textarea, Typo } from "@/butler-ds";
import { useProfileMigrationPrompt } from "./useProfileMigrationPrompt";

const FEEDBACK_TONE = { ok: "success", muted: "secondary", error: "danger" } as const;

/** One row of Settings → Personalization → import from other AIs, below the detected tools. */
export function PersonalizationProfileMigration() {
  useAppLocale();
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
      <Stack align="row" cross="center" gap="sm" data-setting-id="profile-migration">
        <Stack grow minWidth="0">
          <ListRow icon={<Sparkles size="md" />} title={settingsFields.profileMigrationImport}
            description={settingsDescriptions.profileMigration} />
        </Stack>
        <Button
          type="button"
          size="sm"
          id="profile-migration-import"
          variant="outline"
          aria-label={`${settingsCopy.actions.openProfileMigration} · ${settingsFields.profileMigrationImport}`}
          aria-expanded={migrationExpanded}
          aria-controls="profile-migration-fields"
          onClick={() => setMigrationExpanded((current) => !current)}
          disabled={saving || !personalization}
        >
          {migrationExpanded
            ? settingsCopy.actions.closeProfileMigration
            : settingsCopy.actions.openProfileMigration}
        </Button>
      </Stack>
      {migrationFeedback ? (
        <Typo.Caption
          aria-live="polite"
          data-test-class="profile-migration-status"
          data-tone={migrationFeedback.tone}
          role="status"
          tone={FEEDBACK_TONE[migrationFeedback.tone]}
        >
          {migrationFeedback.label}
        </Typo.Caption>
      ) : null}
      {migrationExpanded ? (
        <Stack id="profile-migration-fields" gap="xl">
          <SettingsField
            id="profile-migration-prompt"
            settingId="profile-migration-prompt"
            data-test-class="settings-field"
            label={settingsFields.profileMigrationPrompt}
            controlWidth="full"
            control={<>
            <Textarea id="profile-migration-prompt" value={migrationPrompt} rows={8} readOnly />
            <Stack align="row" justify="end">
              <Button type="button" variant="outline" onClick={copyMigrationPrompt} disabled={!migrationPrompt}>
                {settingsCopy.actions.copyMigrationPrompt}
              </Button>
            </Stack>
            </>}
          />
          <SettingsField
            id="profile-migration-dump"
            settingId="profile-migration-dump"
            data-test-class="settings-field"
            label={settingsFields.profileMigrationDump}
            controlWidth="full"
            control={<>
            <Textarea
              id="profile-migration-dump"
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
                disabled={saving || migrationSubmitting || !personalization || !migrationDump.trim()}
              >
                {migrationSubmitting
                  ? settingsCopy.actions.importProfileMigrationRunning
                  : settingsCopy.actions.importProfileMigration}
              </Button>
            </Stack>
            </>}
          />
        </Stack>
      ) : null}
    </>
  );
}
