import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { runtimeModels } from "@/app/utils.ts";
import { SettingsPage, SettingsSection } from "./SettingsFormComponents";
import { FallbackConsolidationFields } from "./FallbackConsolidationFields";
import { WorkerProfileControls } from "./WorkerProfileControls";
import { WorkerProfileEditor } from "./WorkerProfileEditor";
import {
  WORKER_PROFILES_LIMIT,
  createWorkerProfileInNextSlot,
  removeWorkerProfileById,
} from "./workerProfileUpdates";
import type { WorkerProfile } from "@/app/types.ts";

/** Advanced model settings: backup and cleanup models, and worker profiles. */
export function HelperModelsSettings() {
  useAppLocale();
  const draft = useSettingsUIStore((state) => state.draft);
  const update = useSettingsUIStore((state) => state.update);
  const setSettings = useButlerStore((state) => state.setSettings);
  const modelCatalog = useButlerStore((state) => state.modelCatalog);

  const settingsCopy = appCopy.settings;
  const models = runtimeModels(modelCatalog);

  if (!draft) return null;
  const workerProfiles = draft.worker_profiles ?? [];

  function profileAt(index: number, partial: Partial<WorkerProfile>) {
    return workerProfiles.map((profile, profileIndex) =>
      profileIndex === index ? { ...profile, ...partial } : profile,
    );
  }

  function updateProfile(index: number, partial: Partial<WorkerProfile>) {
    update({ worker_profiles: profileAt(index, partial) }, setSettings);
  }

  function addProfile() {
    const created = createWorkerProfileInNextSlot(workerProfiles, models);
    if (created) {
      update({ worker_profiles: [...workerProfiles, created] }, setSettings);
    }
  }

  function deleteProfile(id: string) {
    const remaining = removeWorkerProfileById(workerProfiles, id);
    if (remaining.length !== workerProfiles.length) {
      update({ worker_profiles: remaining }, setSettings);
    }
  }

  const sections = settingsCopy.pageSections;
  return (
    <SettingsPage>
      <SettingsSection
        id="fallback-consolidation"
        kind="form"
        title={sections.fallbackConsolidation}
        description={settingsCopy.pageSectionDescriptions.fallbackConsolidation}
      >
        <FallbackConsolidationFields />
      </SettingsSection>
      <SettingsSection
        id="worker-profiles"
        kind="list"
        title={sections.workerProfiles}
        description={workerProfiles.length < WORKER_PROFILES_LIMIT
          ? undefined
          : settingsCopy.workerProfilesPanel.addLimitReached}
        actions={
          <WorkerProfileControls
            canAdd={workerProfiles.length < WORKER_PROFILES_LIMIT}
            maxSimultaneousWorkers={draft.max_simultaneous_workers}
            onAdd={() => addProfile()}
            onMaxChange={(value) => update({ max_simultaneous_workers: value }, setSettings)}
          />
        }
      >
        {workerProfiles.map((profile, index) => (
          <WorkerProfileEditor
            key={profile.id}
            profile={profile}
            models={models}
            onUpdate={(partial) => updateProfile(index, partial)}
            onDelete={() => deleteProfile(profile.id)}
          />
        ))}
      </SettingsSection>
    </SettingsPage>
  );
}
