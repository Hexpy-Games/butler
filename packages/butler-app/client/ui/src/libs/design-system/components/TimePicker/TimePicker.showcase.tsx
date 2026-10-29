import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { SettingsField, SettingsFieldScopeProvider } from "../../blocks/SettingsField";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { TimePicker, type TimePickerProps } from "./TimePicker";

export const meta: ShowcaseMeta = {
  title: "TimePicker",
  category: "Input",
  tags: ["form", "time", "settings", "schedule"],
  status: "stable",
};

const labels = {
  "en-US": {
    time: "Time", timeHint: "Runs only while Butler is on.", pick: "Choose time",
    h23: "24-hour (en-GB)", h12: "12-hour (en-US)", ko: "Korean (ko-KR)", de: "24-hour (de-DE)",
    offStep: "A typed 04:07 joins the 5-minute list in order.",
  },
  "ko-KR": {
    time: "실행 시간", timeHint: "버틀러가 켜져 있을 때만 실행합니다.", pick: "시간 고르기",
    h23: "24시간제 (en-GB)", h12: "12시간제 (en-US)", ko: "한국어 (ko-KR)", de: "24시간제 (de-DE)",
    offStep: "직접 입력한 04:07은 5분 단위 목록에 순서대로 들어갑니다.",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

/** The viewer's own locale first; an English page shows no Korean day period. */
function localeSamples(context: ShowcaseRenderContext): [string, string][] {
  const copy = text(context);
  return context.locale === "ko-KR"
    ? [["ko-KR", copy.ko], ["en-US", copy.h12], ["en-GB", copy.h23]]
    : [["en-US", copy.h12], ["en-GB", copy.h23], ["de-DE", copy.de]];
}

function Picker({ initial = "04:00", ...props }: Omit<TimePickerProps, "value" | "onValueChange"> & { initial?: string }) {
  const [value, setValue] = useState(initial);
  return <TimePicker {...props} value={value} onValueChange={setValue} />;
}

export const stories: ShowcaseStory[] = [
  {
    name: "Settings time field",
    render: (context) => (
      <SettingsFieldScopeProvider>
        <SettingsField id={`ds-time-${context.locale}`} label={text(context).time} description={text(context).timeHint}
          control={<Picker id={`ds-time-${context.locale}`} locale={context.locale} aria-label={text(context).time} pickerLabel={text(context).pick} />} />
      </SettingsFieldScopeProvider>
    ),
  },
  {
    name: "Locales: hour cycle, order and day period",
    render: (context) => (
      <Stack gap="md">
        {localeSamples(context).map(([locale, caption]) => (
          <Stack gap="xs" key={locale}>
            <Typo.Caption tone="secondary">{caption}</Typo.Caption>
            <Picker initial="16:30" locale={locale} aria-label={caption} pickerLabel={text(context).pick} />
          </Stack>
        ))}
      </Stack>
    ),
  },
  {
    name: "Open: wheel columns",
    states: ["open"],
    widths: ["375", "app"],
    render: (context) => (
      <Stack gap="xs">
        <Picker initial="04:07" locale={context.locale} defaultOpen aria-label={text(context).time} pickerLabel={text(context).pick} />
        <Typo.Caption tone="secondary">{text(context).offStep}</Typo.Caption>
      </Stack>
    ),
  },
  {
    name: "Disabled",
    states: ["disabled"],
    render: (context) => <Picker locale={context.locale} disabled aria-label={text(context).time} pickerLabel={text(context).pick} />,
  },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "focus-visible", "disabled"],
  render: (context) => (
    <Picker locale={context.locale} disabled={context.state === "disabled"} aria-label={text(context).time} pickerLabel={text(context).pick} />
  ),
};
