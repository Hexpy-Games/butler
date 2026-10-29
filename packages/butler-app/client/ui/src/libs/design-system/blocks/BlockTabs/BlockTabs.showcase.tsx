import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { KeyValueRow } from "../KeyValueRow";
import { Stack } from "../../components/Stack";
import { BlockTabs } from "./BlockTabs";

export const meta: ShowcaseMeta = {
  title: "BlockTabs",
  category: "Conversation & Activity",
  tags: ["answer block", "tabs", "container"],
  status: "stable",
};

const labels = {
  "en-US": { a: "Seoul", b: "Busan", c: "Jeju", temp: "Temperature", rain: "Rain", values: [["18°", "10%"], ["21°", "0%"], ["23°", "40%"]], name: "Weather by city" },
  "ko-KR": { a: "서울", b: "부산", c: "제주", temp: "기온", rain: "강수 확률", values: [["18°", "10%"], ["21°", "0%"], ["23°", "40%"]], name: "도시별 날씨" },
} as const;

function Cities({ context }: { context: ShowcaseRenderContext }) {
  const copy = labels[context.locale];
  return (
    <BlockTabs
      ariaLabel={copy.name}
      tabs={[copy.a, copy.b, copy.c].map((label, index) => ({
        label,
        content: <Stack gap="xs"><KeyValueRow label={copy.temp} value={copy.values[index]![0]} /><KeyValueRow label={copy.rain} value={copy.values[index]![1]} /></Stack>,
      }))}
    />
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Tabs of blocks", states: ["hover", "focus-visible"], widths: ["375", "app"], render: (context) => <Cities context={context} /> },
];
