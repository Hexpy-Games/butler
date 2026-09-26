import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
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
    on: "On", off: "Off", motion: "The thumb moves on --motion-base with the spring easing; reduced motion switches at once.",
  },
  "ko-KR": {
    fallback: "예비 모델 사용", fallbackHint: "기본 모델이 실패하면 목록의 다음 모델로 다시 시도합니다.",
    developer: "개발자 모드", developerHint: "개발 빌드에서만 사용할 수 있습니다.",
    on: "켜짐", off: "꺼짐", motion: "손잡이는 --motion-base 동안 스프링 이징으로 움직이고, 동작 줄이기에서는 바로 바뀝니다.",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

/** SettingsSwitch pattern: label + description with the switch trailing. */
function SettingsSwitchRow({ context, disabled }: { context: ShowcaseRenderContext; disabled?: boolean }) {
  const [checked, setChecked] = useState(true);
  const copy = text(context);
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={disabled ? "ds-switch-dev" : "ds-switch-fallback"}>{disabled ? copy.developer : copy.fallback}</FieldLabel>
        <FieldDescription id={disabled ? "ds-switch-dev-hint" : "ds-switch-fallback-hint"}>
          {disabled ? copy.developerHint : copy.fallbackHint}
        </FieldDescription>
      </FieldContent>
      <Switch
        aria-describedby={disabled ? "ds-switch-dev-hint" : "ds-switch-fallback-hint"}
        checked={disabled ? false : checked}
        disabled={disabled}
        id={disabled ? "ds-switch-dev" : "ds-switch-fallback"}
        onCheckedChange={setChecked}
      />
    </Field>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Settings switch", render: (context) => <SettingsSwitchRow context={context} /> },
  {
    name: "Sizes and values",
    render: (context) => (
      <Stack gap="sm">
        {(["default", "sm"] as const).map((size) => (
          <Stack align="row" cross="center" gap="md" key={size}>
            <Switch aria-label={`${text(context).on} ${size}`} defaultChecked size={size} />
            <Switch aria-label={`${text(context).off} ${size}`} size={size} />
            <Typo.Caption tone="secondary">{size}</Typo.Caption>
          </Stack>
        ))}
        <Typo.Caption tone="secondary">{text(context).motion}</Typo.Caption>
      </Stack>
    ),
  },
  { name: "Disabled (unavailable)", states: ["disabled"], render: (context) => <SettingsSwitchRow context={context} disabled /> },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "active", "disabled"],
  variants: ["on", "off"],
  render: (context) => (
    <Switch
      aria-label={context.variant === "on" ? text(context).on : text(context).off}
      defaultChecked={context.variant === "on"}
      disabled={context.state === "disabled"}
    />
  ),
};
