import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { IconTile } from "../IconTile";
import { Inline } from "../Inline";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { PROVIDER_LOGO_NAMES, ProviderLogo } from "./ProviderLogo";

export const meta: ShowcaseMeta = {
  title: "ProviderLogo",
  category: "Data display",
  tags: ["logo", "brand", "provider", "service", "model", "first-run"],
  status: "stable",
};

const labels = {
  "en-US": { mono: "Monochrome logos follow the text color", color: "Color logos keep their own fills", size: "Sizes" },
  "ko-KR": { mono: "단색 로고는 글자색을 따릅니다", color: "색 로고는 원래 색을 유지합니다", size: "크기" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Every logo in a tile",
    widths: ["375", "app"],
    render: () => (
      <Inline gap="sm">
        {PROVIDER_LOGO_NAMES.map((name) => <IconTile key={name}><ProviderLogo name={name} size="lg" label={name} /></IconTile>)}
      </Inline>
    ),
  },
  {
    name: "Monochrome and color",
    render: (context) => (
      <Stack gap="sm">
        <Typo.Caption tone="secondary">{text(context).mono}</Typo.Caption>
        <Inline gap="md">
          {PROVIDER_LOGO_NAMES.filter((name) => !["claude", "gemini", "qwen"].includes(name)).map((name) => <ProviderLogo key={name} name={name} size="lg" />)}
        </Inline>
        <Typo.Caption tone="secondary">{text(context).color}</Typo.Caption>
        <Inline gap="md">
          <ProviderLogo name="claude" size="lg" />
          <ProviderLogo name="gemini" size="lg" />
          <ProviderLogo name="qwen" size="lg" />
        </Inline>
      </Stack>
    ),
  },
  {
    name: "Sizes",
    render: (context) => (
      <Stack gap="sm">
        <Typo.Caption tone="secondary">{text(context).size}</Typo.Caption>
        <Inline gap="md">
          <ProviderLogo name="openai" size="sm" />
          <ProviderLogo name="openai" />
          <ProviderLogo name="openai" size="lg" />
        </Inline>
      </Stack>
    ),
  },
];
