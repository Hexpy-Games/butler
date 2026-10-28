import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { SettingsField, SettingsFieldScopeProvider } from "../../blocks/SettingsField";
import { Card } from "../Card";
import { Field, FieldContent, FieldDescription, FieldLabel } from "../Field";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { Switch } from "./Switch";

export const meta: ShowcaseMeta = {
  title: "Switch",
  category: "Input",
  tags: ["form", "toggle", "settings", "motion"],
  status: "stable",
};

const labels = {
  "en-US": {
    fallback: "Use backup models", fallbackHint: "When the main model fails, Butler retries with the next model in the list.",
    developer: "Developer mode", developerHint: "Only available in development builds.",
    reduceMotion: "Reduce motion", followsSystem: "Follows the system setting",
    on: "On", off: "Off", motion: "The thumb moves on --motion-base with the spring easing; reduced motion switches at once.",
    sandbox: "Command sandbox", sandboxHint: "Runs commands that change files in an isolated environment.",
    unavailable: "Not available on this device",
    reasonHint: "Hover or focus the switch: the reason opens to its right, clear of the label and description.",
  },
  "ko-KR": {
    fallback: "예비 모델 사용", fallbackHint: "기본 모델이 실패하면 목록의 다음 모델로 다시 시도합니다.",
    developer: "개발자 모드", developerHint: "개발 빌드에서만 사용할 수 있습니다.",
    reduceMotion: "동작 줄이기", followsSystem: "시스템 설정을 따릅니다",
    on: "켜짐", off: "꺼짐", motion: "손잡이는 --motion-base 동안 스프링 이징으로 움직이고, 동작 줄이기에서는 바로 바뀝니다.",
    sandbox: "명령 격리", sandboxHint: "파일을 바꾸는 명령을 격리된 환경에서 실행합니다.",
    unavailable: "이 기기에서는 사용할 수 없습니다",
    reasonHint: "스위치에 올려 두거나 포커스하면 이유가 오른쪽에 열려 이름과 설명을 가리지 않습니다.",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

/** A switch field: stacked like an input (the default), or the row exception inside a card. */
function SwitchFieldStory({ context, disabled, layout = "stacked" }: { context: ShowcaseRenderContext; disabled?: boolean; layout?: "stacked" | "row" }) {
  const [checked, setChecked] = useState(true);
  const copy = text(context);
  const id = `${disabled ? "ds-switch-dev" : "ds-switch-fallback"}-${layout}`;
  const label = <FieldLabel htmlFor={id}>{disabled ? copy.developer : copy.fallback}</FieldLabel>;
  const description = <FieldDescription id={`${id}-hint`}>{disabled ? copy.developerHint : copy.fallbackHint}</FieldDescription>;
  const control = <Switch aria-describedby={`${id}-hint`} checked={disabled ? false : checked} disabled={disabled} id={id} onCheckedChange={setChecked} />;
  if (layout === "row") {
    return <Card padding="md"><Field orientation="horizontal"><FieldContent>{label}{description}</FieldContent>{control}</Field></Card>;
  }
  return <Field>{label}{description}{control}</Field>;
}

export const stories: ShowcaseStory[] = [
  { name: "Placement: stacked switch field (default)", render: (context) => <SwitchFieldStory context={context} /> },
  { name: "Placement: row switch field (phone or list item in a card)", render: (context) => <SwitchFieldStory context={context} layout="row" /> },
  {
    name: "Sizes and values",
    render: (context) => (
      <Stack gap="sm">
        {(["default", "sm"] as const).map((size) => (
          <Stack gap="xs" key={size}>
            <Typo.Caption tone="secondary">{size}</Typo.Caption>
            <Stack align="row" cross="center" gap="md">
              <Switch aria-label={`${text(context).on} ${size}`} defaultChecked size={size} />
              <Switch aria-label={`${text(context).off} ${size}`} size={size} />
            </Stack>
          </Stack>
        ))}
        <Typo.Caption tone="secondary">{text(context).motion}</Typo.Caption>
      </Stack>
    ),
  },
  { name: "Disabled (unavailable)", states: ["disabled"], render: (context) => <SwitchFieldStory context={context} disabled /> },
  {
    name: "Disabled with a reason (hover or focus)",
    states: ["disabled"],
    render: (context) => (
      <Field>
        <FieldLabel htmlFor="ds-switch-reduce-motion">{text(context).reduceMotion}</FieldLabel>
        <Switch id="ds-switch-reduce-motion" checked disabledReason={text(context).followsSystem} />
      </Field>
    ),
  },
  {
    // DefaultPermissionFields: the command sandbox switch on a device without containment.
    name: "Unavailable setting: reason opens to the right",
    states: ["disabled"],
    render: (context) => (
      <Stack gap="md">
        <SettingsFieldScopeProvider>
          <SettingsField id={`ds-switch-sandbox-${context.locale}`} label={text(context).sandbox} description={text(context).sandboxHint}
            control={<Switch id={`ds-switch-sandbox-${context.locale}`} checked={false} disabledReason={text(context).unavailable} />} />
        </SettingsFieldScopeProvider>
        <Typo.Caption tone="secondary">{text(context).reasonHint}</Typo.Caption>
      </Stack>
    ),
  },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "active", "disabled"],
  variants: ["on", "off", "reason"],
  render: (context) => (
    <Switch
      aria-label={context.variant === "off" ? text(context).off : text(context).on}
      defaultChecked={context.variant !== "off"}
      disabled={context.variant !== "reason" && context.state === "disabled"}
      disabledReason={context.variant === "reason" && context.state === "disabled" ? text(context).followsSystem : undefined}
    />
  ),
};
