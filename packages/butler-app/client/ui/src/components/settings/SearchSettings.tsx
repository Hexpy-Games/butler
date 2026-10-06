import { useAppLocale } from "@/app/copy.ts";
import { useEffect, useId, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { DEFAULT_WEB_SEARCH_SETTINGS } from "@/app/constants.ts";
import { useButlerStore } from "@/app/store.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import type { SettingsView } from "@/app/types.ts";
import { Button, Input, SettingsField, Stack } from "@/butler-ds";
import { SettingsSelect } from "./SettingsFormComponents";
import { useSearchSettingUpdate } from "./hooks/useSearchSettingUpdate";

export { SearchBehaviorFields } from "./SearchBehaviorFields";

type WebSearchSettings = SettingsView["web_search"];

/** Search provider section: the backend and its API key. */
export function SearchProviderFields({ draft }: { draft: Pick<SettingsView, "web_search"> }) {
  useAppLocale();
  const update = useSettingsUIStore((state) => state.update);
  const setSettings = useButlerStore((state) => state.setSettings);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const apiKeyId = useId();
  const apiKeyDescriptionId = useId();
  const copy = appCopy.settings;
  const fields = copy.fields;
  const options = copy.options;
  const descriptions = copy.descriptions;
  const webSearch = draft.web_search ?? DEFAULT_WEB_SEARCH_SETTINGS;
  const apiKeyEnvVar = webSearch.api_key_env_var;

  useEffect(() => {
    setApiKeyDraft("");
  }, [webSearch.provider]);

  const updateSearchSetting = useSearchSettingUpdate();

  async function saveApiKey() {
    const apiKey = apiKeyDraft.trim();
    if (!apiKey) return;
    await update({ web_search: { api_key: apiKey } }, setSettings);
    setApiKeyDraft("");
  }

  return (
    <>
      <SettingsSelect
        settingId="search-provider"
        label={fields.searchProvider}
        description={descriptions.searchProvider}
        value={webSearch.provider}
        onChange={(value) =>
          updateSearchSetting("provider", value as WebSearchSettings["provider"])
        }
        options={[
          { value: "duckduckgo-html", label: options.searchProviderDuckDuckGo },
          { value: "auto", label: options.searchProviderAuto },
          { value: "brave", label: options.searchProviderBrave },
          { value: "tavily", label: options.searchProviderTavily },
          { value: "openai-web-search", label: options.searchProviderOpenAi },
          {
            value: "codex-subscription-web-search",
            label: options.searchProviderCodex,
          },
          { value: "disabled", label: options.searchProviderDisabled },
        ]}
      />
      {apiKeyEnvVar ? (
        <SettingsField
          id={apiKeyId}
          settingId="search-api-key"
          data-test-class="settings-field search-provider-api-key-field"
          label={fields.searchProviderApiKey}
          description={descriptions.searchProviderApiKey(apiKeyEnvVar)}
          descriptionId={apiKeyDescriptionId}
          control={(
            <Stack align="row" gap="sm" wrap>
              <Input
                id={apiKeyId}
                aria-describedby={apiKeyDescriptionId}
                type="password"
                autoComplete="off"
                value={apiKeyDraft}
                placeholder={webSearch.api_key_configured
                  ? descriptions.searchProviderApiKeyConfigured
                  : apiKeyEnvVar}
                onChange={(event) => setApiKeyDraft(event.target.value)}
              />
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={!apiKeyDraft.trim()}
                onClick={() => void saveApiKey()}
              >
                {appCopy.common.save}
              </Button>
            </Stack>
          )}
        />
      ) : null}
    </>
  );
}
