import type { ShowcaseMeta, ShowcaseStory } from "../../showcase";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { ContextDonutButton } from "./ContextDonutButton";

export const meta: ShowcaseMeta = {
  title: "ContextDonutButton",
  category: "Composer",
  tags: ["composer", "context", "usage", "ring"],
  status: "stable",
};

const copy = {
  "en-US": { used: (value: number) => `${value}% used`, label: (value: number) => `Context ${value}% used`, open: "Open (details shown)", disabled: "Disabled" },
  "ko-KR": { used: (value: number) => `${value}% 사용`, label: (value: number) => `컨텍스트 ${value}% 사용`, open: "열림 (상세 표시 중)", disabled: "비활성" },
} as const;

function Sample({ ratio, caption, label, ...props }: { ratio: number; caption: string; label: string; surface?: "plain" | "glass"; disabled?: boolean; "aria-expanded"?: boolean }) {
  return (
    <Stack gap="xs" cross="center">
      <ContextDonutButton ratio={ratio} aria-label={label} {...props} />
      <Typo.Caption>{caption}</Typo.Caption>
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  ...(["plain", "glass"] as const).map((surface): ShowcaseStory => ({
    name: `${surface === "glass" ? "Glass" : "Plain"} surface`,
    states: ["default", "hover", "focus", "pressed", "open", "disabled"],
    render: ({ locale }) => {
      const text = copy[locale];
      return <Stack align="row" gap="xl" wrap>
        <Sample surface={surface} ratio={0.64} caption={text.used(64)} label={text.label(64)} />
        <Sample surface={surface} ratio={0.64} caption={text.open} label={text.label(64)} aria-expanded />
        <Sample surface={surface} ratio={0.64} caption={text.disabled} label={text.label(64)} disabled />
      </Stack>;
    },
  })),
  {
    name: "Usage levels",
    states: ["empty", "partial", "nearly full", "full"],
    render: ({ locale }) => {
      const text = copy[locale];
      return (
        <Stack align="row" gap="xl" wrap>
          {[0.08, 0.35, 0.64, 0.92, 1].map((ratio) => {
            const percent = Math.round(ratio * 100);
            return <Sample key={ratio} ratio={ratio} caption={text.used(percent)} label={text.label(percent)} />;
          })}
        </Stack>
      );
    },
  },
  {
    name: "States",
    states: ["hover", "open", "disabled"],
    render: ({ locale }) => {
      const text = copy[locale];
      return (
        <Stack align="row" gap="xl" wrap>
          <Sample ratio={0.64} caption={text.open} label={text.label(64)} aria-expanded />
          <Sample ratio={0.64} caption={text.disabled} label={text.label(64)} disabled />
        </Stack>
      );
    },
  },
];
