import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { TokenInputControl } from "./TokenInputControl";

export const meta: ShowcaseMeta = {
  title: "TokenInputControl",
  category: "Settings & Forms",
  tags: ["settings", "tokens", "tags", "input"],
  status: "beta",
};

const labels = {
  "en-US": { placeholder: "Add topics, separated by commas", label: "Topics" },
  "ko-KR": { placeholder: "쉼표로 구분해 주제를 추가하세요", label: "주제" },
} as const;

function Topics({ context, initial }: { context: ShowcaseRenderContext; initial: string }) {
  const [value, setValue] = useState(initial);
  const tokens = value.split(",").map((token) => token.trim()).filter(Boolean);
  return (
    <TokenInputControl id={`ds-token-input-${initial.length}`} inputProps={{ "aria-label": labels[context.locale].label }}
      onChange={setValue} placeholder={labels[context.locale].placeholder} tokens={tokens} value={value} />
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Comma-separated tokens", widths: ["375", "app"], render: (context) => <Topics context={context} initial="typescript, design-system, motion" /> },
  { name: "Empty", render: (context) => <Topics context={context} initial="" /> },
];
