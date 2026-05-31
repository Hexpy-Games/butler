import { Button, RefreshCcw, Stack } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { LocalModelDiscoveryRequest } from "@/app/types.ts";
import { LocalModelConfigForm } from "./LocalModelConfigForm";
import { SettingsSection } from "./SettingsFormComponents";

interface LocalModelApiSectionProps {
  platform: LocalModelDiscoveryRequest["platform"];
  setPlatform: (value: LocalModelDiscoveryRequest["platform"]) => void;
  serverUrl: string;
  setServerUrl: (value: string) => void;
  advancedOpen: boolean;
  setAdvancedOpen: (value: boolean) => void;
  canDiscover: boolean;
  discovering: boolean;
  onDiscover: () => void;
}

export function LocalModelApiSection({
  platform,
  setPlatform,
  serverUrl,
  setServerUrl,
  advancedOpen,
  setAdvancedOpen,
  canDiscover,
  discovering,
  onDiscover,
}: LocalModelApiSectionProps) {
  const copy = appCopy.settings.localModels;

  return (
    <SettingsSection title={copy.apiInfoTitle} description={copy.description}>
      <Stack gap="md">
        <LocalModelConfigForm
          platform={platform}
          setPlatform={setPlatform}
          serverUrl={serverUrl}
          setServerUrl={setServerUrl}
          advancedOpen={advancedOpen}
          setAdvancedOpen={setAdvancedOpen}
        />
        <Button
          type="button"
          variant="outline"
          disabled={!canDiscover}
          onClick={onDiscover}
        >
          <RefreshCcw size={15} />{" "}
          {discovering ? copy.discovering : copy.discoverModels}
        </Button>
      </Stack>
    </SettingsSection>
  );
}
