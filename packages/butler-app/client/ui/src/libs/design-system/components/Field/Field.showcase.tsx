import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Input } from "../Input";
import { NativeSelect, NativeSelectOption } from "../NativeSelect";
import { Switch } from "../Switch";
import { Textarea } from "../Textarea";
import { Typo } from "../Typo";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
} from "./Field";

export const meta: ShowcaseMeta = {
  title: "Field",
  category: "Input",
  tags: ["form", "validation", "settings", "mcp"],
  status: "stable",
};

const labels = {
  "en-US": {
    legend: "MCP server", id: "Server ID", transport: "Transport", enabled: "Enabled",
    enabledHint: "Butler connects to this server when a session starts.",
    command: "Command", args: "Arguments", argsHint: "One per line", or: "or",
    url: "Server URL", required: "Server ID is required", tooLong: "Use 64 characters or fewer",
    component: "Butler agent", version: "0.0.21 → 0.0.22 is ready to install",
  },
  "ko-KR": {
    legend: "MCP 서버", id: "서버 ID", transport: "연결 방식", enabled: "사용",
    enabledHint: "세션이 시작되면 Butler가 이 서버에 연결합니다.",
    command: "명령", args: "인자", argsHint: "한 줄에 하나씩 입력", or: "또는",
    url: "서버 URL", required: "서버 ID를 입력하세요", tooLong: "64자 이하로 입력하세요",
    component: "Butler 에이전트", version: "0.0.21 → 0.0.22 설치 준비됨",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "MCP server form",
    widths: ["375", "app"],
    render: (context) => {
      const copy = text(context);
      return (
        <FieldSet>
          <FieldLegend>{copy.legend}</FieldLegend>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="ds-field-id">{copy.id}</FieldLabel>
              <Input id="ds-field-id" defaultValue="github" />
            </Field>
            <Field>
              <FieldLabel htmlFor="ds-field-transport">{copy.transport}</FieldLabel>
              <NativeSelect id="ds-field-transport" defaultValue="stdio">
                <NativeSelectOption value="stdio">stdio</NativeSelectOption>
                <NativeSelectOption value="http">HTTP</NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="ds-field-args">{copy.args}</FieldLabel>
              <Textarea id="ds-field-args" placeholder={copy.argsHint} rows={3} />
              <FieldDescription>{copy.argsHint}</FieldDescription>
            </Field>
          </FieldGroup>
        </FieldSet>
      );
    },
  },
  {
    name: "Horizontal switch field",
    render: (context) => (
      <Field orientation="horizontal">
        <Switch id="ds-field-enabled" defaultChecked />
        <FieldContent>
          <FieldLabel htmlFor="ds-field-enabled">{text(context).enabled}</FieldLabel>
          <FieldDescription>{text(context).enabledHint}</FieldDescription>
        </FieldContent>
      </Field>
    ),
  },
  {
    name: "Status field (update component)",
    render: (context) => (
      <Field>
        <FieldTitle>{text(context).component}</FieldTitle>
        <Typo.Caption>{text(context).version}</Typo.Caption>
      </Field>
    ),
  },
  {
    name: "Separator and errors",
    states: ["invalid"],
    render: (context) => {
      const copy = text(context);
      return (
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="ds-field-command">{copy.command}</FieldLabel>
            <Input id="ds-field-command" aria-invalid="true" placeholder="npx" />
            <FieldError errors={[{ message: copy.required }, { message: copy.tooLong }]} />
          </Field>
          <FieldSeparator>{copy.or}</FieldSeparator>
          <Field>
            <FieldLabel htmlFor="ds-field-url">{copy.url}</FieldLabel>
            <Input id="ds-field-url" defaultValue="https://mcp.example.com/sse" />
            <FieldError>{copy.required}</FieldError>
          </Field>
        </FieldGroup>
      );
    },
  },
];
