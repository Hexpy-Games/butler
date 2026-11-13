import { useEffect, useState } from "react";
import { api } from "@/app/api";
import { appCopy, useAppLocale } from "@/app/copy";
import { notifyError } from "@/app/notifications";
import { Button, ButtonContainer, SettingsFieldGroup, Trash2 } from "@/butler-ds";
import { type ImageSelection, type ImageSettings } from "../images/imageApi";
import { refreshImageSettings, useImageSettingsState } from "../images/imageSettingsState";
import { CustomImageModelForm } from "./CustomImageModelForm";
import { ImageCredentialForm } from "./ImageCredentialForm";
import { ProviderMark } from "./ProviderMark";
import { SettingsSelect } from "./SettingsSelect";

export function ImageModelsSettings() {
  useAppLocale();
  const settings = useImageSettingsState(s => s.settings);
  const [draft, setDraft] = useState<string>();
  const [busy, setBusy] = useState(false);
  const copy = appCopy.conversation.imageTools;
  useEffect(() => { void refreshImageSettings().catch(error => notifyError(error, appCopy.settings.errors.saveFailed)); }, []);
  const modelRef = draft ?? settings?.selected?.model_ref ?? "off";
  const model = settings?.models.find(m => m.model_ref === modelRef);
  const selected = settings?.selected?.model_ref === modelRef ? settings.selected : null;
  const save = async (selection: ImageSelection | null) => {
    setBusy(true);
    try {
      const settings = await api<ImageSettings>("/settings/image-model", { method: "PUT", body: JSON.stringify(selection ?? { selected: null }) });
      useImageSettingsState.setState({ settings }); setDraft(undefined);
    } catch (error) { notifyError(error, appCopy.settings.errors.saveFailed); }
    finally { setBusy(false); }
  };
  const choose = (ref: string) => {
    if (ref === "off") { void save(null); return; }
    if (ref === "add-custom") { setDraft(ref); return; }
    const next = settings?.models.find(m => m.model_ref === ref);
    if (!next) return;
    const key = next.credentials.find(c => c.selectable);
    setDraft(ref);
    if (key || next.provider_id === "custom-image") void save({ model_ref: ref, credential_id: key?.id ?? null, default_quality: next.default_quality });
  };
  const remove = async () => {
    setBusy(true);
    try {
      const settings = await api<ImageSettings>(`/settings/image-model/custom/${encodeURIComponent(modelRef.slice("custom-image/".length))}`, { method: "DELETE" });
      useImageSettingsState.setState({ settings }); setDraft(undefined);
    } catch (error) { notifyError(error, appCopy.settings.errors.saveFailed); }
    finally { setBusy(false); }
  };
  return <SettingsFieldGroup>
    <SettingsSelect settingId="image-model" label={copy.model} value={modelRef} disabled={busy || !settings} onChange={choose}
      options={[{ value: "off", label: copy.off }, ...(settings?.models ?? []).map(m => ({ value: m.model_ref,
        label: m.display_name, icon: <ProviderMark providerId={m.provider_id} />, group: m.provider_id === "custom-image" ? copy.custom : m.provider_label })), { value: "add-custom", label: copy.addCustom, group: copy.custom }]} />
    {modelRef === "add-custom" && <CustomImageModelForm onCancel={() => setDraft(undefined)} onSaved={settings => {
      useImageSettingsState.setState({ settings }); setDraft(undefined);
    }} />}
    {model && <>
      {model.provider_id === "custom-image" ? <ButtonContainer size="default" justify="end">
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void remove()}><Trash2 size="sm" /> {copy.deleteModel}</Button>
      </ButtonContainer> : <ImageCredentialForm key={model.model_ref} providerId={model.provider_id} credentialId={selected?.credential_id ?? null} disabled={busy}
        onSelect={id => save({ model_ref: modelRef, credential_id: id, default_quality: selected?.default_quality ?? model.default_quality })} />}
      {model.qualities.length > 0 && <SettingsSelect settingId="image-quality" label={copy.defaultQuality} value={selected?.default_quality ?? model.default_quality ?? ""}
        disabled={busy || !selected?.credential_id} onChange={quality => void save({ model_ref: modelRef,
          credential_id: selected!.credential_id, default_quality: quality })}
        options={model.qualities.map(value => ({ value, label: copy.quality[value as keyof typeof copy.quality] ?? value }))} />}
    </>}
  </SettingsFieldGroup>;
}
