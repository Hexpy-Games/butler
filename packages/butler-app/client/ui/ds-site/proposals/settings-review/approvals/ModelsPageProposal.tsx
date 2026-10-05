import { useState, type ReactNode } from "react";
import { appCopy, useAppLocale } from "@/app/copy";
import { DisclosureRow } from "@/butler-ds";
import { BackupModelsSummary } from "@/components/settings/BackupModelsSummary";
import { ButlerModelFields } from "@/components/settings/ButlerModelFields";
import { useSavedKeys } from "@/components/settings/hooks/useSavedKeys";
import { useWorkerProfiles } from "@/components/settings/hooks/useWorkerProfiles";
import { MemoryCleanupFields } from "@/components/settings/MemoryCleanupFields";
import { WorkerProfileControls } from "@/components/settings/WorkerProfileControls";
import { WorkerProfileEditor } from "@/components/settings/WorkerProfileEditor";
import { PermissionsFields } from "@/components/settings/PermissionsFields";
import { SavedKeysRows } from "@/components/settings/SavedKeysRows";
import { SettingsPage, SettingsSection } from "@/components/settings/SettingsFormComponents";

// PROPOSAL COPY of ModelsRootPage in components/settings/ModelsSettings.tsx: the same sections in
// the same order with the same product components; the only change is the new grants section
// (`grants`) right after Permissions. The Advanced disclosure stays collapsed here.

export function ModelsPageProposal({ grants }: { grants: ReactNode }) {
  useAppLocale();
  const savedKeys = useSavedKeys();
  const workers = useWorkerProfiles();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const settingsCopy = appCopy.settings;
  const sections = settingsCopy.pageSections;
  return (
    <SettingsPage>
      <SettingsSection id="butler-model" kind="form" title={sections.butlerModel}>
        <ButlerModelFields />
      </SettingsSection>
      <SettingsSection id="backup-models" kind="form" title={sections.backupModels}>
        <BackupModelsSummary />
      </SettingsSection>
      {savedKeys.state !== "unsupported" && (
        <SettingsSection
          id="saved-keys"
          kind="list"
          title={sections.savedKeys}
          state={savedKeys.state === "ready" && savedKeys.credentials.length === 0 ? "empty" : savedKeys.state}
          emptyMessage={settingsCopy.savedKeys.empty}
          onRetry={() => void savedKeys.reload()}
        >
          <SavedKeysRows keys={savedKeys} />
        </SettingsSection>
      )}
      <SettingsSection id="permissions" kind="form" title={sections.permissions}>
        <PermissionsFields />
      </SettingsSection>
      {grants}
      <SettingsSection id="advanced-models" kind="form" title={settingsCopy.modelsAdvanced.title}>
        <DisclosureRow
          data-test-class="settings-models-advanced"
          title={settingsCopy.modelsAdvanced.contents}
          open={advancedOpen}
          onToggle={() => setAdvancedOpen(!advancedOpen)}
        />
      </SettingsSection>
      {advancedOpen && (
        <>
          <SettingsSection id="memory-cleanup" kind="form" title={sections.memoryCleanup}>
            <MemoryCleanupFields />
          </SettingsSection>
          <SettingsSection
            id="worker-profiles"
            kind="list"
            title={sections.workerProfiles}
            description={workers.canAdd ? undefined : settingsCopy.workerProfilesPanel.addLimitReached}
            actions={
              <WorkerProfileControls canAdd={workers.canAdd} maxSimultaneousWorkers={workers.maxSimultaneousWorkers}
                onAdd={workers.addProfile} onMaxChange={workers.setMaxSimultaneousWorkers} />
            }
          >
            {workers.profiles.map((profile, index) => (
              <WorkerProfileEditor key={profile.id} profile={profile} models={workers.models}
                onUpdate={(partial) => workers.updateProfile(index, partial)} onDelete={() => workers.deleteProfile(profile.id)} />
            ))}
          </SettingsSection>
        </>
      )}
    </SettingsPage>
  );
}
