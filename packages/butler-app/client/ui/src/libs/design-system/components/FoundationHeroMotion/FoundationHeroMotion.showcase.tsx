import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Grid } from "../Grid";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { FOUNDATION_HERO_VARIANTS, FoundationHeroMotion, type FoundationHeroVariant } from "./FoundationHeroMotion";

export const meta: ShowcaseMeta = {
  title: "FoundationHeroMotion",
  category: "Data display",
  tags: ["foundations", "hero", "motion", "guidebook", "tokens", "illustration", "loop"],
  status: "beta",
};

const labels = {
  "en-US": {
    color: "01 Color", typography: "02 Typography", spacing: "03 Spacing", sizing: "04 Sizing", radius: "05 Radius and elevation",
    iconography: "06 Iconography", focus: "07 Focus ring", motion: "08 Motion", "z-index": "09 Layers", layout: "10 Layout and platform",
    still: "Still poster: what reduced motion shows",
  },
  "ko-KR": {
    color: "01 색", typography: "02 타이포그래피", spacing: "03 간격", sizing: "04 크기", radius: "05 모서리와 높이",
    iconography: "06 아이콘", focus: "07 포커스 링", motion: "08 모션", "z-index": "09 레이어", layout: "10 레이아웃과 플랫폼",
    still: "정지 포스터: 모션 줄이기에서 보이는 화면",
  },
} as const satisfies Record<ShowcaseRenderContext["locale"], Record<FoundationHeroVariant | "still", string>>;

function Heroes({ context, still = false }: { context: ShowcaseRenderContext; still?: boolean }) {
  const copy = labels[context.locale];
  return (
    <Grid columns={{ base: "1", wide: "2" }} gap="xl">
      {FOUNDATION_HERO_VARIANTS.map((variant) => (
        <Stack gap="sm" key={variant}>
          <FoundationHeroMotion variant={variant} still={still} lang={context.locale === "ko-KR" ? "ko" : "en"} />
          <Typo.Caption tone="secondary">{copy[variant]}</Typo.Caption>
        </Stack>
      ))}
    </Grid>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "All chapters", render: (context) => <Heroes context={context} /> },
  {
    name: "Still posters",
    render: (context) => (
      <Stack gap="md">
        <Typo.Caption tone="tertiary">{labels[context.locale].still}</Typo.Caption>
        <Heroes context={context} still />
      </Stack>
    ),
  },
];
