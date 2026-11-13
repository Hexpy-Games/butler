import { useState } from "react";
import { api } from "@/app/api";
import { appCopy } from "@/app/copy";
import { notifyError, notifyStatus } from "@/app/notifications";
import { Button, ButtonContainer, Input, SettingsField } from "@/butler-ds";
import type { ImageSettings } from "../images/imageApi";

export function CustomImageModelForm({ onCancel, onSaved }: {
  onCancel: () => void; onSaved: (settings: ImageSettings) => void;
}) {
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const copy = appCopy.conversation.imageTools;
  const save = async () => {
    setBusy(true);
    try {
      const settings = await api<ImageSettings>("/settings/image-model/custom", { method: "POST", body: JSON.stringify({
        display_name: name, api_base_url: endpoint, model_id: model, ...(key.trim() ? { api_key: key } : {}),
      }) });
      setKey("");
      notifyStatus(appCopy.settings.modelManagement.registeredStatus(name), { tone: "ok" });
      onSaved(settings);
    } catch (error) { notifyError(error, appCopy.settings.errors.saveFailed); }
    finally { setBusy(false); }
  };
  return <>
    <SettingsField id="custom-image-name" label={copy.name}
      control={<Input id="custom-image-name" value={name} disabled={busy} onChange={e => setName(e.target.value)} />} />
    <SettingsField id="custom-image-endpoint" label={copy.endpointUrl}
      control={<Input id="custom-image-endpoint" value={endpoint} disabled={busy} onChange={e => setEndpoint(e.target.value)} />} />
    <SettingsField id="custom-image-model" label={copy.modelId}
      control={<Input id="custom-image-model" value={model} disabled={busy} onChange={e => setModel(e.target.value)} />} />
    <SettingsField id="custom-image-key" label={copy.optionalApiKey}
      control={<Input id="custom-image-key" type="password" value={key} disabled={busy} onChange={e => setKey(e.target.value)} />} />
    <ButtonContainer size="default" justify="end">
      <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>{appCopy.common.cancel}</Button>
      <Button type="button" disabled={busy || !name.trim() || !endpoint.trim() || !model.trim()} onClick={() => void save()}>{appCopy.common.save}</Button>
    </ButtonContainer>
  </>;
}
