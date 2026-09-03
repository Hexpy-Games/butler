import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingsField,
} from "@/butler-ds";
import { useId } from "react";
import { appCopy } from "@/app/copy.ts";
import { modelDisplayName, tokenWindowLabel } from "@/app/utils.ts";
import type { LocalModelDiscoveryResult } from "@/app/types.ts";

interface LocalModelDiscoveryFormProps {
  discovery: LocalModelDiscoveryResult;
  selectedModelRef: string;
  setSelectedModelRef: (value: string) => void;
}

export function LocalModelDiscoveryForm({
  discovery,
  selectedModelRef,
  setSelectedModelRef,
}: LocalModelDiscoveryFormProps) {
  const copy = appCopy.settings.localModels;
  const controlId = useId();
  const descriptionId = useId();

  if (discovery.models.length === 0) return null;

  return (
    <SettingsField
      id={controlId}
      data-test-class="settings-field"
      label={copy.discoveredModel}
      description={copy.discoveredModelDescription}
      descriptionId={descriptionId}
      control={
        <Select value={selectedModelRef} onValueChange={setSelectedModelRef}>
          <SelectTrigger id={controlId} aria-describedby={descriptionId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {discovery.models.map((model) => (
                <SelectItem key={model.model_ref} value={model.model_ref}>
                  {modelDisplayName(model)} (
                  {tokenWindowLabel(model.context_window_tokens)})
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      }
    />
  );
}
