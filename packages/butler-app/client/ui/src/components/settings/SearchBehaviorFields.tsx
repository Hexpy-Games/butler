import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { DEFAULT_WEB_SEARCH_SETTINGS } from "@/app/constants.ts";
import type { SettingsView } from "@/app/types.ts";
import { SettingsSelect, SettingsSwitch } from "./SettingsFormComponents";
import { useSearchSettingUpdate } from "./hooks/useSearchSettingUpdate";

type WebSearchSettings = SettingsView["web_search"];

/** Search behavior section: page reader, search planning and its depth. */
export function SearchBehaviorFields({ draft }: { draft: Pick<SettingsView, "web_search"> }) {
  useAppLocale();
  const updateSearchSetting = useSearchSettingUpdate();
  const copy = appCopy.settings;
  const fields = copy.fields;
  const options = copy.options;
  const descriptions = copy.descriptions;
  const webSearch = draft.web_search ?? DEFAULT_WEB_SEARCH_SETTINGS;
  return (
    <>
      <SettingsSelect
        settingId="search-reader"
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
        settingId="search-planning"
        label={fields.searchPlanningEnabled}
        description={descriptions.searchPlanning}
        checked={webSearch.planning_enabled}
        onChange={(checked) => updateSearchSetting("planning_enabled", checked)}
      />
      {webSearch.planning_enabled ? (
        <SettingsSelect
          settingId="search-depth"
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
    </>
  );
}
