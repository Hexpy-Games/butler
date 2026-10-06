import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Input } from "../../components/Input";
import { Switch } from "../../components/Switch";
import { FormSection } from "../FormSection";
import { SettingsField } from "./SettingsField";
import { SettingsFieldScopeProvider } from "./settingsFieldScope";

export const meta: ShowcaseMeta = {
  title: "SettingsField",
  category: "Settings & Forms",
  tags: ["settings", "field", "form"],
  status: "stable",
};

const labels = {
  "en-US": {
    name: "Display name",
    nameDescription: "Shown in Butler messages.",
    meta: "Saved locally",
    smartGroups: "Smart groups",
    smartGroupsDescription: "Automatically organize new conversations by topic. Manually moved conversations stay where you put them.",
    timezone: "Timezone",
    section: "General",
    port: "Port",
    portDescription: "Local port for the web app.",
    portError: "Enter a number from 1024 to 65535.",
  },
  "ko-KR": {
    name: "표시 이름",
    nameDescription: "Butler 메시지에 표시됩니다.",
    meta: "로컬에 저장됨",
    smartGroups: "스마트 그룹",
    smartGroupsDescription: "새 대화를 주제별로 자동 정리합니다. 직접 옮긴 대화는 옮긴 자리에 그대로 둡니다.",
    timezone: "시간대",
    section: "일반",
    port: "포트",
    portDescription: "웹 앱이 쓰는 로컬 포트입니다.",
    portError: "1024부터 65535까지의 숫자를 입력하세요.",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Label, description, control, meta",
    render: (context) => (
      <SettingsFieldScopeProvider>
        <SettingsField id="field-name" label={text(context).name} description={text(context).nameDescription}
          control={<Input id="field-name" defaultValue="Butler" />} meta={text(context).meta} />
      </SettingsFieldScopeProvider>
    ),
  },
  {
    name: "Switch stacks under its copy",
    render: (context) => (
      <SettingsFieldScopeProvider>
        <SettingsField id="field-groups" label={text(context).smartGroups} description={text(context).smartGroupsDescription}
          control={<Switch id="field-groups" />} />
      </SettingsFieldScopeProvider>
    ),
  },
  {
    name: "Error under the control",
    states: ["invalid"],
    render: (context) => (
      <SettingsFieldScopeProvider>
        <SettingsField id="field-port" label={text(context).port} description={text(context).portDescription}
          control={<Input id="field-port" defaultValue="80" />} error={text(context).portError} />
      </SettingsFieldScopeProvider>
    ),
  },
  {
    name: "Field ramp inside a section card",
    widths: ["375", "app", "wide"],
    render: (context) => (
      <FormSection title={text(context).section}>
        <SettingsField id="ramp-groups" label={text(context).smartGroups} description={text(context).smartGroupsDescription}
          control={<Switch id="ramp-groups" />} />
        <SettingsField id="ramp-name" label={text(context).name} description={text(context).nameDescription}
          control={<Input id="ramp-name" defaultValue="Butler" />} />
        <SettingsField id="ramp-timezone" label={text(context).timezone} control={<Input id="ramp-timezone" defaultValue="Asia/Seoul" />} />
      </FormSection>
    ),
  },
];
