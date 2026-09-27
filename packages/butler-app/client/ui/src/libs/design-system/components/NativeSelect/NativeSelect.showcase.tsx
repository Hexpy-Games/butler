import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { Field, FieldLabel } from "../Field";
import { Stack } from "../Stack";
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "./NativeSelect";

export const meta: ShowcaseMeta = {
  title: "NativeSelect",
  category: "Input",
  tags: ["form", "mobile", "select", "settings"],
  status: "stable",
};

const labels = {
  "en-US": {
    transport: "Transport", source: "Value source", literal: "Literal value", env: "Environment variable",
    keychain: "Keychain", kind: "Log kind", all: "All kinds", turn: "Model turns", turnError: "Model turn errors",
    local: "Local", remote: "Remote",
  },
  "ko-KR": {
    transport: "연결 방식", source: "값 출처", literal: "직접 입력", env: "환경 변수",
    keychain: "키체인", kind: "로그 종류", all: "모든 종류", turn: "모델 턴", turnError: "모델 턴 오류",
    local: "로컬", remote: "원격",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

function SourceSelect({ context, size, disabled }: { context: ShowcaseRenderContext; size?: "sm"; disabled?: boolean }) {
  const copy = text(context);
  return (
    <NativeSelect aria-label={copy.source} defaultValue="env" disabled={disabled} size={size}>
      <NativeSelectOption value="literal">{copy.literal}</NativeSelectOption>
      <NativeSelectOption value="env">{copy.env}</NativeSelectOption>
      <NativeSelectOption value="keychain">{copy.keychain}</NativeSelectOption>
    </NativeSelect>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Secret value source", render: (context) => <SourceSelect context={context} /> },
  {
    name: "Sizes (default, sm)",
    render: (context) => (
      <Stack align="row" cross="center" gap="sm" wrap>
        <SourceSelect context={context} />
        <SourceSelect context={context} size="sm" />
      </Stack>
    ),
  },
  {
    name: "In a form field",
    render: (context) => (
      <Field>
        <FieldLabel htmlFor="ds-native-transport">{text(context).transport}</FieldLabel>
        <NativeSelect id="ds-native-transport" defaultValue="http">
          <NativeSelectOption value="stdio">stdio</NativeSelectOption>
          <NativeSelectOption value="http">HTTP</NativeSelectOption>
          <NativeSelectOption value="sse">SSE</NativeSelectOption>
        </NativeSelect>
      </Field>
    ),
  },
  {
    name: "Grouped options, stretched",
    widths: ["320", "375", "app"],
    render: (context) => (
      <NativeSelect aria-label={text(context).kind} defaultValue="model_turn" stretch>
        <NativeSelectOption value="all">{text(context).all}</NativeSelectOption>
        <NativeSelectOptGroup label={text(context).local}>
          <NativeSelectOption value="model_turn">{text(context).turn}</NativeSelectOption>
          <NativeSelectOption value="model_turn_error">{text(context).turnError}</NativeSelectOption>
        </NativeSelectOptGroup>
      </NativeSelect>
    ),
  },
  { name: "Disabled", states: ["disabled"], render: (context) => <SourceSelect context={context} disabled /> },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "disabled"],
  variants: ["default", "sm"],
  render: (context) => (
    <SourceSelect context={context} disabled={context.state === "disabled"} size={context.variant === "sm" ? "sm" : undefined} />
  ),
};
