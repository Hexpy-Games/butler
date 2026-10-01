import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { Field, FieldDescription, FieldLabel } from "../Field";
import { Stack } from "../Stack";
import { Input } from "./Input";

export const meta: ShowcaseMeta = {
  title: "Input",
  category: "Input",
  tags: ["form", "text-entry", "settings"],
  status: "stable",
};

const labels = {
  "en-US": {
    serverId: "Server ID", serverName: "Display name", placeholder: "Placeholder only", apiKey: "API key",
    // Keys are a local file today; only claim Keychain storage once #217 lands.
    apiKeyHint: "Stays on this computer; only the last four characters are shown.",
    modelId: "Model ID", context: "Context window", oauth: "Sign-in link", invalid: "Must be a number", maxWorkers: "Max simultaneous Workers",
    values: { id: "github", name: "GitHub", key: "sk-…4f2a", model: "qwen2.5-coder:14b", context: "32768" },
  },
  "ko-KR": {
    serverId: "서버 ID", serverName: "표시 이름", placeholder: "플레이스홀더만", apiKey: "API 키",
    apiKeyHint: "이 컴퓨터에만 저장되며 마지막 네 글자만 보입니다.",
    modelId: "모델 ID", context: "컨텍스트 창", oauth: "로그인 링크", invalid: "숫자를 입력하세요", maxWorkers: "최대 동시 Worker 수",
    values: { id: "github", name: "깃허브", key: "sk-…4f2a", model: "qwen2.5-coder:14b", context: "32768" },
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    // Value vs placeholder: values use the default text color, placeholders stay muted.
    name: "Value and placeholder",
    render: (context) => (
      <Stack gap="sm">
        <Field>
          <FieldLabel htmlFor="ds-input-server-id">{text(context).serverId}</FieldLabel>
          <Input id="ds-input-server-id" defaultValue={text(context).values.id} placeholder={text(context).serverId} />
        </Field>
        <Input aria-label="Placeholder input" placeholder={text(context).placeholder} />
      </Stack>
    ),
  },
  {
    name: "Settings form (MCP server)",
    widths: ["375", "app"],
    render: (context) => (
      <Stack gap="sm">
        <Field>
          <FieldLabel htmlFor="ds-input-mcp-id">{text(context).serverId}</FieldLabel>
          <Input id="ds-input-mcp-id" defaultValue={text(context).values.id} />
        </Field>
        <Field>
          <FieldLabel htmlFor="ds-input-mcp-name">{text(context).serverName}</FieldLabel>
          <Input id="ds-input-mcp-name" defaultValue={text(context).values.name} />
        </Field>
      </Stack>
    ),
  },
  {
    name: "Masked key (disabled) and read-only link",
    states: ["disabled", "read-only"],
    render: (context) => (
      <Stack gap="sm">
        <Field>
          <FieldLabel htmlFor="ds-input-key">{text(context).apiKey}</FieldLabel>
          <Input id="ds-input-key" value={text(context).values.key} disabled readOnly />
          <FieldDescription>{text(context).apiKeyHint}</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="ds-input-oauth">{text(context).oauth}</FieldLabel>
          <Input id="ds-input-oauth" value="https://auth.example.com/device?code=BTLR-7Q2X" readOnly />
        </Field>
      </Stack>
    ),
  },
  {
    name: "Numeric and invalid",
    states: ["invalid"],
    render: (context) => (
      <Stack gap="sm">
        <Field>
          <FieldLabel htmlFor="ds-input-context">{text(context).context}</FieldLabel>
          <Input id="ds-input-context" inputMode="numeric" defaultValue={text(context).values.context} />
        </Field>
        <Field>
          <FieldLabel htmlFor="ds-input-context-bad">{text(context).context}</FieldLabel>
          <Input id="ds-input-context-bad" aria-invalid="true" inputMode="numeric" defaultValue="32k" />
          <FieldDescription>{text(context).invalid}</FieldDescription>
        </Field>
      </Stack>
    ),
  },
  {
    name: "Compact number in a toolbar",
    render: (context) => (
      <Stack align="row" cross="center" gap="sm">
        <FieldLabel htmlFor="ds-input-max-workers">{text(context).maxWorkers}</FieldLabel>
        <Input id="ds-input-max-workers" compact type="number" inputMode="numeric" min={1} max={8} defaultValue="3" />
      </Stack>
    ),
  },
  {
    name: "Underline · in-place entry",
    widths: ["375", "app"],
    render: (context) => (
      <Field>
        <FieldLabel htmlFor="ds-input-underline">{text(context).serverName}</FieldLabel>
        <Input id="ds-input-underline" variant="underline" placeholder={text(context).serverName} />
      </Field>
    ),
  },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "disabled", "invalid", "read-only"],
  variants: ["value", "placeholder", "underline value", "underline placeholder"],
  render: (context) => (
    <Input
      variant={context.variant?.startsWith("underline") ? "underline" : "default"}
      readOnly={context.state === "read-only"}
      aria-invalid={context.state === "invalid" ? "true" : undefined}
      aria-label={text(context).modelId}
      defaultValue={context.variant?.endsWith("value") ? text(context).values.model : undefined}
      disabled={context.state === "disabled"}
      placeholder={text(context).modelId}
    />
  ),
};
