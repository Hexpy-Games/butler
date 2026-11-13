import { useAppLocale } from "@/app/copy.ts";
import { useState } from "react";
import { Button, Plus } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import { modelDisplayName } from "@/app/utils.ts";
import { SettingsSection } from "./SettingsFormComponents";
import { ModelRouteFrame } from "./ModelRouteFrame";
import { RegisteredModelRow } from "./RegisteredModelRow";
import type { AppModelSummary } from "@/app/types.ts";

export function ModelManagementPage({ models, onAdd, onEdit, onDelete, sectionId, title, showTokenCaption = true }: {
  models: AppModelSummary[]; onAdd: () => void; onEdit?: (modelRef: string) => void;
  onDelete: (model: AppModelSummary) => Promise<void>; sectionId: string; title: string; showTokenCaption?: boolean;
}) {
  useAppLocale();
  const [busyModelRef, setBusyModelRef] = useState("");
  const copy = appCopy.settings.modelManagement;

  async function remove(model: AppModelSummary) {
    setBusyModelRef(model.model_ref);
    try {
      await onDelete(model);
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
    <ModelRouteFrame title={title}>
      <SettingsSection
        id={sectionId}
        kind="list"
        title={copy.registeredTitle}
        state={models.length === 0 ? "empty" : "ready"}
        emptyMessage={copy.emptyRegistered}
        actions={
          <Button type="button" onClick={onAdd} size="sm" variant="outline">
            <Plus size="md" /> {copy.addButton}
          </Button>
        }
      >
        {models.map((model) => (
          <RegisteredModelRow
            key={model.model_ref}
            model={model}
            showTokenCaption={showTokenCaption}
            busy={busyModelRef === model.model_ref}
            onEdit={onEdit ? () => onEdit(model.model_ref) : undefined}
            onDelete={() => void remove(model)}
          />
        ))}
      </SettingsSection>
    </ModelRouteFrame>
  );
}
