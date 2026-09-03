import { useEffect, useId, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { DEFAULT_WEB_SEARCH_SETTINGS } from "@/app/constants.ts";
import { useButlerStore } from "@/app/store.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import type { SettingsView } from "@/app/types.ts";
import { Button, Input, SettingsField, Stack } from "@/butler-ds";
import {
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "./SettingsFormComponents";

type WebSearchSettings = SettingsView["web_search"];
type WebSearchWritableKey =
  | "provider"
  | "reader_backend"
  | "planning_enabled"
  | "planning_default_depth";

export function SearchSettings({ draft }: { draft: SettingsView }) {
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

  function updateSearchSetting<K extends WebSearchWritableKey>(
    key: K,
    value: WebSearchSettings[K],
  ) {
    update({
      web_search: {
        [key]: value,
      },
    }, setSettings);
  }

  async function saveApiKey() {
    const apiKey = apiKeyDraft.trim();
    if (!apiKey) return;
    await update({ web_search: { api_key: apiKey } }, setSettings);
    setApiKeyDraft("");
  }

  return (
    <SettingsSection
      title={fields.searchSettings}
      description={descriptions.searchSettings}
    >
      <SettingsSelect
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
          data-test-class="settings-field search-provider-api-key-field"
          label={fields.searchProviderApiKey}
          description={descriptions.searchProviderApiKey(apiKeyEnvVar)}
          descriptionId={apiKeyDescriptionId}
          control={(
            <Stack align="row" gap="2" wrap>
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
      <SettingsSelect
        label={fields.searchReaderBackend}
        description={descriptions.searchReaderBackend}
        value={webSearch.reader_backend}
        onChange={(value) =>
          updateSearchSetting(
            "reader_backend",
            value as WebSearchSettings["reader_backend"],
          )
        }
        options={[
          { value: "lightweight", label: options.searchReaderLightweight },
          { value: "auto", label: options.searchReaderAuto },
          { value: "lightpanda", label: options.searchReaderLightpanda },
          { value: "jina-hosted", label: options.searchReaderJina },
          { value: "disabled", label: options.searchReaderDisabled },
        ]}
      />
      <SettingsSwitch
        label={fields.searchPlanningEnabled}
        description={descriptions.searchPlanning}
        checked={webSearch.planning_enabled}
        onChange={(checked) => updateSearchSetting("planning_enabled", checked)}
      />
      {webSearch.planning_enabled ? (
        <SettingsSelect
          label={fields.searchDefaultDepth}
          value={webSearch.planning_default_depth}
          onChange={(value) =>
            updateSearchSetting(
              "planning_default_depth",
              value as WebSearchSettings["planning_default_depth"],
            )
          }
          options={[
            { value: "quick", label: options.searchDepthQuick },
            { value: "balanced", label: options.searchDepthBalanced },
            { value: "deep", label: options.searchDepthDeep },
          ]}
        />
      ) : null}
    </SettingsSection>
  );
}
