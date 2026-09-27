import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { SettingsField, SettingsFieldScopeProvider } from "../SettingsField";
import { PercentInputControl } from "./PercentInputControl";

export const meta: ShowcaseMeta = {
  title: "PercentInputControl",
  category: "Settings & Forms",
  tags: ["settings", "percent", "slider", "number"],
  status: "beta",
};

const labels = {
  "en-US": { label: "Local reasoning budget", description: "Share of the context a local model may spend on reasoning." },
  "ko-KR": { label: "로컬 추론 예산", description: "로컬 모델이 추론에 쓸 수 있는 컨텍스트 비율입니다." },
} as const;

function Budget({ context, min, max, disabled }: { context: ShowcaseRenderContext; min?: number; max?: number; disabled?: boolean }) {
  const [value, setValue] = useState(40);
  const id = `ds-percent-${min ?? 0}-${disabled ? "off" : "on"}`;
  const text = labels[context.locale];
  return (
    <SettingsFieldScopeProvider>
      <SettingsField id={id} label={text.label} description={text.description} descriptionId={`${id}-help`}
        control={<PercentInputControl id={id} inputLabel={text.label} sliderLabel={text.label} describedBy={`${id}-help`}
          disabled={disabled} max={max} min={min} value={value} onCommit={(next) => { setValue(next); return true; }} />} />
    </SettingsFieldScopeProvider>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "In a settings field", widths: ["375", "app"], render: (context) => <Budget context={context} /> },
  { name: "Bounded range (40–90%)", render: (context) => <Budget context={context} min={40} max={90} /> },
  { name: "Disabled while saving", render: (context) => <Budget context={context} disabled /> },
];
