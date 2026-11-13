import { useEffect, useState } from "react";
import { api } from "@/app/api";
import { appCopy, useAppLocale } from "@/app/copy";
import { notifyError } from "@/app/notifications";
import { Button, Settings, SettingsFieldGroup } from "@/butler-ds";
import { useSettingsUIStore } from "@/stores/settingsUIStore";
import { type ImageSelection, type ImageSettings } from "../images/imageApi";
import { refreshImageSettings, useImageSettingsState } from "../images/imageSettingsState";
import { ProviderMark } from "./ProviderMark";
import { SettingsSelect } from "./SettingsSelect";

export function ImageModelsSettings() {
  useAppLocale();
  const settings = useImageSettingsState(s => s.settings);
  const openManagement = useSettingsUIStore(s => s.openImageModelManagement);
  const [busy, setBusy] = useState(false);
  const copy = appCopy.conversation.imageTools;
  useEffect(() => { void refreshImageSettings().catch(error => notifyError(error, appCopy.settings.errors.saveFailed)); }, []);
  const selected = settings?.selected;
  const model = settings?.models.find(m => m.model_ref === selected?.model_ref);
  const save = async (selection: ImageSelection | null) => {
    setBusy(true);
    try {
      const settings = await api<ImageSettings>("/settings/image-model", { method: "PUT", body: JSON.stringify(selection ?? { selected: null }) });
      useImageSettingsState.setState({ settings });
    } catch (error) { notifyError(error, appCopy.settings.errors.saveFailed); }
    finally { setBusy(false); }
  };
  const choose = (ref: string) => {
    if (ref === "off") { void save(null); return; }
    const next = settings?.models.find(m => m.model_ref === ref);
    if (next) void save({ model_ref: ref, credential_id: next.credential_id, default_quality: next.default_quality });
  };
  return <SettingsFieldGroup>
    <SettingsSelect controlWidth="full" settingId="image-model" label={copy.model} value={selected?.model_ref ?? "off"} disabled={busy || !settings} onChange={choose}
      action={<Button type="button" size="lg" variant="outline" data-test-class="settings-image-model-management-button" onClick={openManagement}>
        <Settings size="md" /> {appCopy.settings.modelManagement.manageButton}
      </Button>}
      options={[{ value: "off", label: copy.off }, ...(settings?.models ?? []).filter(m => settings?.registered.includes(m.model_ref)).map(m => ({ value: m.model_ref,
        label: m.display_name, icon: <ProviderMark providerId={m.provider_id} />, group: m.provider_id === "custom-image" ? copy.custom : m.provider_label }))]} />
    {model && model.qualities.length > 0 && <SettingsSelect settingId="image-quality" label={copy.defaultQuality} value={selected?.default_quality ?? model.default_quality ?? ""}
      disabled={busy} onChange={quality => void save({ model_ref: model.model_ref,
        credential_id: selected!.credential_id, default_quality: quality })}
      options={model.qualities.map(value => ({ value, label: copy.quality[value as keyof typeof copy.quality] ?? value }))} />}
  </SettingsFieldGroup>;
}
