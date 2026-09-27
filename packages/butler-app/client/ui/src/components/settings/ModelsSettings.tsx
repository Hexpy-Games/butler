import { useAppLocale } from "@/app/copy.ts";
import { useState } from "react";
import { DisclosureRow } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { SettingsPage, SettingsSection } from "./SettingsFormComponents";
import { BackupModelsSummary } from "./BackupModelsSummary";
import { ButlerModelFields } from "./ButlerModelFields";
import { MemoryCleanupFields } from "./MemoryCleanupFields";
import { PermissionsFields } from "./PermissionsFields";
import { ModelAddEditPage } from "./ModelAddEditPage";
import { ModelManagementPage } from "./ModelManagementPage";
import { WorkerProfileControls } from "./WorkerProfileControls";
import { WorkerProfileEditor } from "./WorkerProfileEditor";
import { useWorkerProfiles } from "./hooks/useWorkerProfiles";

/**
 * The Models page. The main model, backup models and permissions are always
 * visible; memory cleanup and worker profiles sit in a collapsed Advanced
 * disclosure on the same page.
 */
export function ModelsSettings() {
  useAppLocale();
  const draft = useSettingsUIStore((state) => state.draft);
  const modelRoute = useSettingsUIStore((state) => state.modelRoute);
  const workers = useWorkerProfiles();
  const [advancedOpen, setAdvancedOpen] = useState(false);

  if (!draft) return null;

  if (modelRoute.page === "management") return <ModelManagementPage />;
  if (modelRoute.page === "add") return <ModelAddEditPage />;
  if (modelRoute.page === "edit") {
    return <ModelAddEditPage modelRef={modelRoute.modelRef} />;
  }

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
      <SettingsSection id="permissions" kind="form" title={sections.permissions}>
        <PermissionsFields />
      </SettingsSection>
      <SettingsSection id="advanced-models" kind="form" title={settingsCopy.modelsAdvanced.title}>
        <DisclosureRow
          surface="plain"
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
              <WorkerProfileControls
                canAdd={workers.canAdd}
                maxSimultaneousWorkers={workers.maxSimultaneousWorkers}
                onAdd={workers.addProfile}
                onMaxChange={workers.setMaxSimultaneousWorkers}
              />
            }
          >
            {workers.profiles.map((profile, index) => (
              <WorkerProfileEditor
                key={profile.id}
                profile={profile}
                models={workers.models}
                onUpdate={(partial) => workers.updateProfile(index, partial)}
                onDelete={() => workers.deleteProfile(profile.id)}
              />
            ))}
          </SettingsSection>
        </>
      )}
    </SettingsPage>
  );
}
