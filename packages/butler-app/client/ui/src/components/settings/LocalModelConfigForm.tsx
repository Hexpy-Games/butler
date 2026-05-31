import { Button, Input, SettingsField, SlidersHorizontal, Stack } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { LocalModelDiscoveryRequest } from "@/app/types.ts";
import { SettingsSelect } from "./SettingsFormComponents";

const API_TYPE = "openai_compatible" as const;
const PLATFORM_OPTIONS = [
  { value: "llama_cpp", label: "llama.cpp" },
  { value: "ollama", label: "Ollama" },
  { value: "lm_studio", label: "LM Studio" },
  { value: "custom", label: "Custom OpenAI-compatible" },
] as const;

interface LocalModelConfigFormProps {
  platform: LocalModelDiscoveryRequest["platform"];
  setPlatform: (value: LocalModelDiscoveryRequest["platform"]) => void;
  serverUrl: string;
  setServerUrl: (value: string) => void;
  advancedOpen: boolean;
  setAdvancedOpen: (value: boolean) => void;
}

export function LocalModelConfigForm({
  platform,
  setPlatform,
  serverUrl,
  setServerUrl,
  advancedOpen,
  setAdvancedOpen,
}: LocalModelConfigFormProps) {
  const copy = appCopy.settings.localModels;

  return (
    <Stack gap="md">
      <SettingsField
        id="local-model-server-url"
        data-test-class="settings-field"
        label={copy.serverUrl}
        control={
          <Input
            id="local-model-server-url"
            placeholder="http://localhost:8080"
            value={serverUrl}
            onChange={(event) => setServerUrl(event.target.value)}
          />
        }
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setAdvancedOpen(!advancedOpen)}
      >
        <SlidersHorizontal size={15} />{" "}
        {advancedOpen ? copy.hideAdvanced : copy.showAdvanced}
      </Button>
      {advancedOpen ? (
        <Stack gap="md">
          <SettingsSelect
            disabled
            label={copy.apiType}
            description={copy.apiDescription}
            value={API_TYPE}
            onChange={() => undefined}
            options={[{ value: API_TYPE, label: "OpenAI-compatible" }]}
          />
          <SettingsSelect
            label={copy.platformHint}
            value={platform}
            onChange={(value) =>
              setPlatform(value as LocalModelDiscoveryRequest["platform"])
            }
            options={PLATFORM_OPTIONS.map((option) => ({
              value: option.value,
              label:
                option.value === "custom"
                  ? copy.customOpenAiCompatible
                  : option.label,
            }))}
          />
        </Stack>
      ) : null}
    </Stack>
  );
}
