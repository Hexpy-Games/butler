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
  "en-US": { label: "Compact context at", description: "Butler summarizes older turns when the context reaches this share." },
  "ko-KR": { label: "컨텍스트 압축 시점", description: "컨텍스트가 이 비율에 닿으면 Butler가 이전 턴을 요약합니다." },
} as const;

function Compaction({ context, min, max }: { context: ShowcaseRenderContext; min?: number; max?: number }) {
  const [value, setValue] = useState(64);
  const id = `ds-percent-${min ?? 0}`;
  return (
    <SettingsFieldScopeProvider>
      <SettingsField id={id} label={labels[context.locale].label} description={labels[context.locale].description}
        control={<PercentInputControl id={id} max={max} min={min} onChange={setValue} value={value} />} />
    </SettingsFieldScopeProvider>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "In a settings field", widths: ["375", "app"], render: (context) => <Compaction context={context} /> },
  { name: "Bounded range (40–90%)", render: (context) => <Compaction context={context} min={40} max={90} /> },
];
