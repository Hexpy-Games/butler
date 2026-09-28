import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { ButlerThinkingMark } from "../ButlerThinkingMark";
import { AlertCircle, Globe2, Monitor, ShieldCheck } from "../Icons";
import { Inline } from "../Inline";
import { ProviderLogo } from "../ProviderLogo";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { IconTile } from "./IconTile";

export const meta: ShowcaseMeta = {
  title: "IconTile",
  category: "Data display",
  tags: ["icon", "logo", "tile", "glyph", "first-run"],
  status: "stable",
};

const labels = {
  "en-US": { title: "Asks before changing anything", body: "Butler asks before it edits files or runs commands." },
  "ko-KR": { title: "바꾸기 전에 먼저 묻습니다", body: "파일을 고치거나 명령을 실행하기 전에 허락을 구합니다." },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Sizes and tones",
    render: () => (
      <Inline gap="md">
        <IconTile size="sm" tone="accent"><ShieldCheck size="md" /></IconTile>
        <IconTile><ProviderLogo name="openai" size="lg" /></IconTile>
        <IconTile size="lg"><Globe2 size="xl" /></IconTile>
        <IconTile size="lg" tone="danger"><AlertCircle size="xl" /></IconTile>
        <IconTile size="xl" tone="plain"><ButlerThinkingMark /></IconTile>
        <IconTile><Monitor size="lg" /></IconTile>
      </Inline>
    ),
  },
  {
    name: "A point in a consent list",
    widths: ["375", "app"],
    render: (context) => (
      <Stack align="row" cross="start" gap="md">
        <IconTile size="sm" tone="accent"><ShieldCheck size="md" /></IconTile>
        <Stack gap="none">
          <Typo.Label as="span" weight="semibold">{text(context).title}</Typo.Label>
          <Typo.Caption tone="secondary">{text(context).body}</Typo.Caption>
        </Stack>
      </Stack>
    ),
  },
];
