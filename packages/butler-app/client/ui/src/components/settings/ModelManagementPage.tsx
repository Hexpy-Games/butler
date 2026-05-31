import { useState } from "react";
import { Button, Plus, Stack, Typo } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import { modelDisplayName } from "@/app/utils.ts";
import { useButlerStore } from "@/app/store.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { SettingsSection } from "./SettingsFormComponents";
import { ModelRouteFrame } from "./ModelRouteFrame";
import { RegisteredModelRow } from "./RegisteredModelRow";
import { deleteRegisteredModel } from "./modelManagementApi";
import { registeredModels } from "./modelManagementUtils";
import type { AppModelSummary } from "@/app/types.ts";

export function ModelManagementPage() {
  const modelCatalog = useButlerStore((state) => state.modelCatalog);
  const setModelCatalog = useButlerStore((state) => state.setModelCatalog);
  const openAdd = useSettingsUIStore((state) => state.openModelAdd);
  const openEdit = useSettingsUIStore((state) => state.openModelEdit);
  const [busyModelRef, setBusyModelRef] = useState("");
  const copy = appCopy.settings.modelManagement;
  const models = registeredModels(modelCatalog);

  async function remove(model: AppModelSummary) {
    setBusyModelRef(model.model_ref);
    try {
      const result = await deleteRegisteredModel(model);
      setModelCatalog(result.catalog);
      notifyStatus(copy.deletedStatus(modelDisplayName(model)), {
        id: "model-delete",
        tone: "ok",
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "Deletion cancelled") {
        notifyError(error, copy.errors.delete, { id: "model-delete" });
      }
    } finally {
      setBusyModelRef("");
    }
  }

  return (
    <ModelRouteFrame title={copy.title}>
      <SettingsSection title={copy.registeredTitle}>
        <Stack gap="md">
          <Button type="button" onClick={openAdd} size="sm">
            <Plus size={15} /> {copy.addButton}
          </Button>
          {models.length === 0 ? (
            <Typo.Caption>{copy.emptyRegistered}</Typo.Caption>
          ) : (
            models.map((model) => (
              <RegisteredModelRow
                key={model.model_ref}
                model={model}
                busy={busyModelRef === model.model_ref}
                onEdit={() => openEdit(model.model_ref)}
                onDelete={() => void remove(model)}
              />
            ))
          )}
        </Stack>
      </SettingsSection>
    </ModelRouteFrame>
  );
}
