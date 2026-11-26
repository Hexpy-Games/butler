import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Inline } from "../Inline";
import { Typo } from "../Typo";
import { Badge } from "./Badge";

export const meta: ShowcaseMeta = {
  title: "Badge",
  category: "Data display",
  tags: ["badge", "plan", "plus", "pro", "tier"],
  status: "stable",
};

const labels = {
  "en-US": { feature: "Connect from anywhere", tooltip: "Available on Plus and above." },
  "ko-KR": { feature: "어디서나 연결", tooltip: "Plus 요금제 이상에서 제공됩니다." },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Plans",
    render: () => (
      <Inline>
        <Badge>Plus</Badge>
        <Badge>Pro</Badge>
        <Badge>Enterprise</Badge>
      </Inline>
    ),
  },
  {
    name: "With tooltip",
    render: (context) => {
      const { feature, tooltip } = text(context);
      return (
        <Inline gap="xs" cross="center">
          <Typo.Label>{feature}</Typo.Label>
          <Badge tooltip={tooltip}>Plus</Badge>
        </Inline>
      );
    },
  },
];
