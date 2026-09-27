import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { Separator } from "./Separator";

export const meta: ShowcaseMeta = {
  title: "Separator",
  category: "Layout",
  tags: ["layout", "structure", "divider", "settings"],
  status: "stable",
};

const labels = {
  "en-US": {
    rows: [
      { name: "Input tokens", value: "1.2M" },
      { name: "Output tokens", value: "184K" },
      { name: "Cached tokens", value: "912K" },
    ],
    line: "Line", space: "Spacing only", vertical: "Vertical", accent: "Accent", sources: "3 sources",
  },
  "ko-KR": {
    rows: [
      { name: "입력 토큰", value: "1.2M" },
      { name: "출력 토큰", value: "184K" },
      { name: "캐시된 토큰", value: "912K" },
    ],
    line: "선", space: "간격만", vertical: "세로", accent: "강조", sources: "출처 3개",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Line, spacing and vertical",
    render: (context) => (
      <Stack gap="sm">
        <Typo.Body>{text(context).line}</Typo.Body>
        <Separator line tone="default" />
        <Typo.Body>{text(context).space}</Typo.Body>
        <Separator line={false} space="md" />
        <Stack align="row" cross="center" gap="sm">
          <Typo.Body>{text(context).vertical}</Typo.Body>
          <Separator orientation="vertical" tone="accent" />
          <Typo.Body>{text(context).accent}</Typo.Body>
        </Stack>
      </Stack>
    ),
  },
  {
    // Usage panels: a separator between rows, never before the first one.
    name: "Between usage rows",
    widths: ["375", "app"],
    render: (context) => (
      <Stack gap="none">
        {text(context).rows.map((row, index) => (
          <Stack gap="none" key={row.name}>
            {index > 0 ? <Separator space="md" /> : null}
            <Stack align="row" justify="between" gap="md">
              <Typo.Body as="div">{row.name}</Typo.Body>
              <Typo.Body as="div" tone="secondary">{row.value}</Typo.Body>
            </Stack>
          </Stack>
        ))}
      </Stack>
    ),
  },
  {
    name: "Tones",
    render: () => (
      <Stack gap="xs">
        {(["default", "strong", "muted", "accent"] as const).map((tone) => (
          <Stack gap="none" key={tone}>
            <Typo.Caption tone="secondary">{tone}</Typo.Caption>
            <Separator tone={tone} />
          </Stack>
        ))}
      </Stack>
    ),
  },
  {
    name: "Space none (statistic sources)",
    render: (context) => (
      <Stack gap="md">
        <Separator space="none" />
        <Typo.Caption>{text(context).sources}</Typo.Caption>
      </Stack>
    ),
  },
];
