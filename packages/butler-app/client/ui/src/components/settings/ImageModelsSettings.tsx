import { useEffect, useState } from "react";
import { api } from "@/app/api";
import { appCopy, useAppLocale } from "@/app/copy";
import { notifyError } from "@/app/notifications";
import { SettingsFieldGroup } from "@/butler-ds";
import { type ImageSelection, type ImageSettings } from "../images/imageApi";
import { refreshImageSettings, useImageSettingsState } from "../images/imageSettingsState";
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
    const next = settings?.models.find(m => m.model_ref === ref);
    if (!next) return;
    const key = next.credentials.find(c => c.selectable);
    setDraft(ref);
    if (key) void save({ model_ref: ref, credential_id: key.id, default_quality: next.default_quality });
  };
  return <SettingsFieldGroup>
    <SettingsSelect settingId="image-model" label={copy.model} value={modelRef} disabled={busy || !settings} onChange={choose}
      options={[{ value: "off", label: copy.off }, ...(settings?.models ?? []).map(m => ({ value: m.model_ref,
        label: m.display_name, icon: <ProviderMark providerId={m.provider_id} />, group: m.provider_label }))]} />
    {model && <>
      <SettingsSelect settingId="image-credential" label={copy.apiKey} value={selected?.credential_id ?? ""} disabled={busy}
        onChange={id => void save({ model_ref: modelRef, credential_id: id, default_quality: selected?.default_quality ?? model.default_quality })}
        options={model.credentials.map(c => ({ value: c.id, label: c.label, description: c.masked_value || undefined,
          disabled: !c.selectable, disabledReason: c.selectable ? undefined : copy.apiKeyOnly }))} />
      {!model.credentials.some(c => c.selectable) && <ImageCredentialForm key={model.provider_id} providerId={model.provider_id}
        onSaved={async id => { await save({ model_ref: modelRef, credential_id: id, default_quality: model.default_quality }); }} />}
      <SettingsSelect settingId="image-quality" label={copy.defaultQuality} value={selected?.default_quality ?? model.default_quality}
        disabled={busy || !selected?.credential_id} onChange={quality => void save({ model_ref: modelRef,
          credential_id: selected!.credential_id, default_quality: quality })}
        options={model.qualities.map(value => ({ value, label: copy.quality[value as keyof typeof copy.quality] ?? value }))} />
    </>}
  </SettingsFieldGroup>;
}
