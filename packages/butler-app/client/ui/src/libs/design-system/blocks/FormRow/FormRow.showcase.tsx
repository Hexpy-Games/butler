import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Input } from "../../components/Input";
import { Stack } from "../../components/Stack";
import { Switch } from "../../components/Switch";
import { FormRow } from "./FormRow";

export const meta: ShowcaseMeta = {
  title: "FormRow",
  category: "Settings & Forms",
  tags: ["form", "label", "help", "error"],
  status: "beta",
};

const labels = {
  "en-US": {
    name: "Project name", nameHelp: "Choose a unique name for the project.", notify: "Notifications", notifyHelp: "Alert me when a long turn finishes.",
    key: "API key", keyError: "Keys start with sk-", placeholder: "My project",
  },
  "ko-KR": {
    name: "프로젝트 이름", nameHelp: "겹치지 않는 이름을 고르세요.", notify: "알림", notifyHelp: "긴 턴이 끝나면 알려 줍니다.",
    key: "API 키", keyError: "키는 sk-로 시작합니다", placeholder: "내 프로젝트",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Help and error",
    states: ["invalid"],
    widths: ["375", "app"],
    render: (context) => (
      <Stack gap="xl">
        <FormRow htmlFor="ds-form-row-name" label={text(context).name} help={text(context).nameHelp}>
          <Input id="ds-form-row-name" placeholder={text(context).placeholder} />
        </FormRow>
        <FormRow htmlFor="ds-form-row-notify" label={text(context).notify} help={text(context).notifyHelp}>
          <Switch id="ds-form-row-notify" defaultChecked />
        </FormRow>
        <FormRow htmlFor="ds-form-row-key" label={text(context).key} error={text(context).keyError}>
          <Input id="ds-form-row-key" aria-invalid="true" defaultValue="pk-live-…" />
        </FormRow>
      </Stack>
    ),
  },
];
