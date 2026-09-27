import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { SettingsField, SettingsFieldScopeProvider } from "../SettingsField";
import { TokenInputControl } from "./TokenInputControl";

export const meta: ShowcaseMeta = {
  title: "TokenInputControl",
  category: "Settings & Forms",
  tags: ["settings", "tokens", "budget", "slider", "number"],
  status: "beta",
};

const labels = {
  "en-US": { label: "Context limit", description: "Maximum tokens Butler keeps in context. The model allows up to 400K." },
  "ko-KR": { label: "컨텍스트 한도", description: "버틀러가 컨텍스트에 유지할 최대 토큰 수입니다. 모델 최대치는 400K입니다." },
} as const;

function ContextLimit({ context, initial }: { context: ShowcaseRenderContext; initial: number }) {
  const [value, setValue] = useState(initial);
  const id = `ds-token-input-${initial}`;
  const text = labels[context.locale];
  return (
    <SettingsFieldScopeProvider>
      <SettingsField id={id} label={text.label} description={text.description} descriptionId={`${id}-help`}
        control={<TokenInputControl id={id} inputLabel={text.label} sliderLabel={text.label} describedBy={`${id}-help`}
          min={1000} max={400000} value={value} onCommit={setValue} />} />
    </SettingsFieldScopeProvider>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Context limit", widths: ["375", "app"], render: (context) => <ContextLimit context={context} initial={200000} /> },
  { name: "At the model maximum", render: (context) => <ContextLimit context={context} initial={400000} /> },
];
