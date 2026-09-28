import { useButlerStore } from "@/app/store.ts";
import { runtimeModels } from "@/app/utils.ts";
import type { WorkerProfile } from "@/app/types.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import {
  WORKER_PROFILES_LIMIT,
  createWorkerProfileInNextSlot,
  removeWorkerProfileById,
} from "../workerProfileUpdates";

/** Worker profiles in the settings draft and the edits the Models page applies to them. */
export function useWorkerProfiles() {
  const draft = useSettingsUIStore((state) => state.draft);
  const update = useSettingsUIStore((state) => state.update);
  const setSettings = useButlerStore((state) => state.setSettings);
  const modelCatalog = useButlerStore((state) => state.modelCatalog);
  const models = runtimeModels(modelCatalog);
  const profiles = draft?.worker_profiles ?? [];

  function updateProfile(index: number, partial: Partial<WorkerProfile>) {
    const next = profiles.map((profile, profileIndex) =>
      profileIndex === index ? { ...profile, ...partial } : profile,
    );
    update({ worker_profiles: next }, setSettings);
  }

  function addProfile() {
    const created = createWorkerProfileInNextSlot(profiles, models);
    if (created) update({ worker_profiles: [...profiles, created] }, setSettings);
  }

  function deleteProfile(id: string) {
    const remaining = removeWorkerProfileById(profiles, id);
    if (remaining.length !== profiles.length) {
      update({ worker_profiles: remaining }, setSettings);
    }
  }

  function setMaxSimultaneousWorkers(value: number) {
    update({ max_simultaneous_workers: value }, setSettings);
  }

  return {
    profiles,
    models,
    canAdd: profiles.length < WORKER_PROFILES_LIMIT,
    maxSimultaneousWorkers: draft?.max_simultaneous_workers ?? 0,
    updateProfile,
    addProfile,
    deleteProfile,
    setMaxSimultaneousWorkers,
  };
}
