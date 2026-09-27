import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { MetaList } from "./MetaList";

export const meta: ShowcaseMeta = {
  title: "MetaList",
  category: "Data display",
  tags: ["metadata", "description list", "caption", "usage"],
  status: "stable",
};

const labels = {
  "en-US": { title: "conversation", input: "Input", cache: "Cache", output: "Output", source: "Local telemetry",
    requests: "Requests", plan: "Plan", pro: "Pro" },
  "ko-KR": { title: "대화", input: "입력", cache: "캐시", output: "출력", source: "로컬 원격 측정",
    requests: "요청", plan: "플랜", pro: "Pro" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Usage row",
    widths: ["320", "375", "app"],
    render: (context) => (
      <Stack gap="xs">
        <Typo.Body>{text(context).title}</Typo.Body>
        <MetaList items={[
          { label: text(context).input, value: "36,460" },
          { label: text(context).cache, value: "8,200" },
          { label: text(context).output, value: "4,420" },
        ]} />
      </Stack>
    ),
  },
  {
    name: "Value-only entry",
    render: (context) => (
      <MetaList items={[
        { value: text(context).source },
        { label: text(context).requests, value: "24" },
        { label: text(context).plan, value: text(context).pro },
      ]} />
    ),
  },
];
