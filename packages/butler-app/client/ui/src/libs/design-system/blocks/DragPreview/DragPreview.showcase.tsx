import type { ReactNode } from "react";
import type { ShowcaseMeta, ShowcaseStory } from "../../showcase";
import { Grid } from "../../components/Grid";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { cropImage, stripCrop } from "../BrowserPane/fixtures/pages";
import { ICONS } from "../TabStrip/TabStrip.demo";
import { DragPreview } from "./DragPreview";
import { FloatingStage } from "./DragPreview.demo";

export const meta: ShowcaseMeta = {
  title: "DragPreview",
  category: "Browser",
  tags: ["browser", "drag", "drop", "ghost", "elements", "tab", "invalid", "floating", "pointer"],
  status: "beta",
};

const CROPS = [{ src: cropImage(0) }, { src: cropImage(1) }];
const TITLE = { "en-US": "Search results — Shop", "ko-KR": "검색 결과 — 쇼핑" } as const;

function Labeled({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <Stack gap="md" cross="start">
      {children}
      <Typo.Caption tone="tertiary">{caption}</Typo.Caption>
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  {
    name: "Picked elements",
    render: () => (
      <Stack align="row" gap="2xl" wrap>
        <Labeled caption="1"><DragPreview kind="elements" images={CROPS.slice(0, 1)} /></Labeled>
        <Labeled caption="2"><DragPreview kind="elements" images={CROPS} /></Labeled>
        <Labeled caption="12"><DragPreview kind="elements" images={CROPS} count={12} /></Labeled>
        <Labeled caption="invalid"><DragPreview kind="elements" images={CROPS} invalid /></Labeled>
      </Stack>
    ),
  },
  {
    // Block crops (a heading, a line of text, a filter column) sit whole on the matte, never cut mid-glyph.
    name: "Wide and tall crops sit whole",
    render: ({ locale }) => (
      <Stack align="row" gap="2xl" wrap>
        <Labeled caption="heading"><DragPreview kind="elements" images={[{ src: stripCrop("heading", locale) }]} /></Labeled>
        <Labeled caption="line + column"><DragPreview kind="elements" images={[{ src: stripCrop("line", locale) }, { src: stripCrop("column", locale) }]} /></Labeled>
      </Stack>
    ),
  },
  {
    name: "Lifted tab",
    states: ["invalid"],
    render: ({ locale }) => (
      <Stack align="row" gap="2xl" wrap>
        <DragPreview kind="tab" title={TITLE[locale]} icon={<img src={ICONS.shop} alt="" />} />
        <DragPreview kind="tab" title={TITLE[locale]} icon={<img src={ICONS.shop} alt="" />} invalid />
      </Stack>
    ),
  },
  {
    // Floating mode: `at` is the pointer; the preview sits just below and right of the tip. Move the pointer.
    name: "Floating: follows the pointer",
    states: ["invalid"],
    widths: ["app", "wide"],
    render: ({ locale }) => (
      <Grid columns="2" gap="md">
        <FloatingStage locale={locale} kind="elements" />
        <FloatingStage locale={locale} kind="tab" start={{ x: 40, y: 64 }} />
      </Grid>
    ),
  },
  {
    name: "Floating at mobile width",
    widths: ["375"],
    render: ({ locale }) => <FloatingStage locale={locale} kind="elements" />,
  },
];
