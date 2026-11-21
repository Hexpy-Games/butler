import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { useAppLocale } from "@/i18n";
import { SettingsScreen, SettingsGroup, LoadState } from "@/settings/layout";
import { SelectRow, SwitchRow } from "@/settings/rows";
import { useSettings } from "@/settings/useSettings";
import type { AccessMode } from "@/settings/types";

export default function GeneralSettings() {
  const app = getAppCopy(useAppLocale());
  const S = app.settings;
  const { settings, error, reload, update } = useSettings();
  const accessOptions = (factory: AccessMode) => ([
    ["auto", "auto"], ["read_only", "readOnly"], ["ask_first", "askAlways"], ["ask_except_reads", "askFirst"], ["full_access", "fullAccess"],
  ] as const).map(([value, key]) => ({ value, label: app.permissions[key], description: app.permissions[`${key}Desc`],
    meta: [value === "auto" ? app.permissions.recommended : "", value === factory ? app.interfaceDetails.default : ""].filter(Boolean).join(" · ") }));
  return <SettingsScreen title={S.sections.general} description={S.sectionDescriptions.general}>
    {!settings ? <LoadState error={error} onRetry={reload} /> : <>
      <SettingsGroup title={S.pageSections.languageRegion}>
        <SelectRow title={S.fields.timezone} description={S.descriptions.timezone} value={settings.timezone.trim() || "UTC"}
          options={timezoneOptions()} search={{ label: S.options.timezoneSearch, empty: S.options.timezoneEmpty }} onSelect={timezone => { void update({ timezone }); }} />
      </SettingsGroup>
      <SettingsGroup title={S.pageSections.conversationInput}>
        <SelectRow title={S.fields.followUpBehavior} value={settings.follow_up_behavior} options={[
          { value: "queue", label: S.options.queueWhileBusy }, { value: "steer", label: S.options.steerCurrentTurn },
        ]} onSelect={follow_up_behavior => { void update({ follow_up_behavior }); }} />
        <SwitchRow title={S.fields.planModeDefault} value={settings.plan_mode_default} onChange={plan_mode_default => { void update({ plan_mode_default }); }} />
      </SettingsGroup>
      <SettingsGroup title={S.pageSections.sidebar} description={S.pageSectionDescriptions.sidebar}>
        <SwitchRow title={app.interfaceDetails.smartGroups} description={app.interfaceDetails.smartGroupsDescription}
          value={settings.smart_grouping_enabled} onChange={smart_grouping_enabled => { void update({ smart_grouping_enabled }); }} />
      </SettingsGroup>
      <SettingsGroup title={S.pageSections.defaultPermission}>
        <SelectRow title={S.fields.chatAccess} description={S.descriptions.chatAccess} value={settings.access_mode}
          options={accessOptions("ask_except_reads")} onSelect={access_mode => { void update({ access_mode }); }} />
        <SelectRow title={S.fields.scheduleAccess} description={S.descriptions.scheduleAccess} value={settings.schedule_access_mode ?? "auto"}
          options={accessOptions("auto")} onSelect={schedule_access_mode => { void update({ schedule_access_mode }); }} />
        <SwitchRow title={S.fields.commandSandbox} description={settings.command_sandbox_available ? S.descriptions.commandSandbox : S.descriptions.commandSandboxUnavailable}
          value={(settings.command_sandbox_enabled ?? true) && settings.command_sandbox_available === true} disabled={!settings.command_sandbox_available}
          onChange={command_sandbox_enabled => { void update({ command_sandbox_enabled }); }} />
      </SettingsGroup>
      <SettingsGroup title={S.pageSections.searchProvider} description={S.pageSectionDescriptions.searchProvider}>
        <SelectRow title={S.fields.searchProvider} description={S.descriptions.searchProvider} value={settings.web_search.provider} options={[
          { value: "duckduckgo-html", label: S.options.searchProviderDuckDuckGo }, { value: "auto", label: S.options.searchProviderAuto },
          { value: "brave", label: S.options.searchProviderBrave }, { value: "tavily", label: S.options.searchProviderTavily },
          { value: "openai-web-search", label: S.options.searchProviderOpenAi }, { value: "chatgpt-plan-web-search", label: S.options.searchProviderChatGpt },
          { value: "disabled", label: S.options.searchProviderDisabled },
        ]} onSelect={provider => { void update({ web_search: { provider } }); }} />
      </SettingsGroup>
      <SettingsGroup title={S.pageSections.searchBehavior} description={S.pageSectionDescriptions.searchBehavior}>
        <SelectRow title={S.fields.searchReaderBackend} description={S.descriptions.searchReaderBackend} value={settings.web_search.reader_backend} options={[
          { value: "browser", label: S.options.searchReaderBrowser }, { value: "lightweight", label: S.options.searchReaderLightweight },
          { value: "auto", label: S.options.searchReaderAuto }, { value: "lightpanda", label: S.options.searchReaderLightpanda },
          { value: "jina-hosted", label: S.options.searchReaderJina }, { value: "disabled", label: S.options.searchReaderDisabled },
        ]} onSelect={reader_backend => { void update({ web_search: { reader_backend } }); }} />
        <SwitchRow title={S.fields.searchPlanningEnabled} description={S.descriptions.searchPlanning} value={settings.web_search.planning_enabled}
          onChange={planning_enabled => { void update({ web_search: { planning_enabled } }); }} />
        {settings.web_search.planning_enabled ? <SelectRow title={S.fields.searchDefaultDepth} value={settings.web_search.planning_default_depth} options={[
          { value: "quick", label: S.options.searchDepthQuick }, { value: "balanced", label: S.options.searchDepthBalanced }, { value: "deep", label: S.options.searchDepthDeep },
        ]} onSelect={planning_default_depth => { void update({ web_search: { planning_default_depth } }); }} /> : null}
      </SettingsGroup>
    </>}
  </SettingsScreen>;
}

function timezoneOptions(): Array<{ value: string; label: string }> {
  const fallback = ["UTC", "Asia/Seoul", "America/Los_Angeles", "America/New_York", "Europe/London", "Europe/Paris"];
  const timezones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : fallback;
  return [...new Set(["UTC", ...timezones])].map(timezone => ({ value: timezone, label: timezone.replace(/_/gu, " ") }));
}
