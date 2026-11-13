import { api } from "@/app/api";
import { appCopy } from "@/app/copy";
import { confirmAction } from "@/app/confirmation";
import type { AppModelSummary } from "@/app/types";
import { useSettingsUIStore } from "@/stores/settingsUIStore";
import type { ImageModel, ImageSettings } from "../images/imageApi";
import { useImageSettingsState } from "../images/imageSettingsState";
import { ModelManagementPage } from "./ModelManagementPage";

export function imageModelSummary(model: ImageModel): AppModelSummary {
  return { provider_id: model.provider_id,
    provider_label: model.provider_id === "custom-image" ? appCopy.conversation.imageTools.custom : model.provider_label,
    display_name: model.display_name, model_ref: model.model_ref, model_id: model.model_ref.split("/").slice(1).join("/"),
    status: "available", default_reasoning_effort: "none", reasoning_efforts: [], token_estimator: "", runtime_supported: false };
}

export function ImageModelManagementPage() {
  const settings = useImageSettingsState(s => s.settings);
  const openAdd = useSettingsUIStore(s => s.openImageModelAdd);
  const copy = appCopy.settings.modelManagement;
  const remove = async (model: AppModelSummary) => {
    if (!await confirmAction(copy.deleteConfirm(model.display_name), {
      title: appCopy.common.delete, confirmLabel: appCopy.common.delete, destructive: true,
    })) throw new Error("Deletion cancelled");
    const settings = await api<ImageSettings>(`/settings/image-model/registered/${encodeURIComponent(model.model_ref)}`, { method: "DELETE" });
    useImageSettingsState.setState({ settings });
  };
  return <ModelManagementPage models={(settings?.models ?? []).filter(m => settings?.registered.includes(m.model_ref)).map(imageModelSummary)}
    onAdd={openAdd} onDelete={remove} showTokenCaption={false} sectionId="registered-image-models" title={copy.imageTitle} />;
}
