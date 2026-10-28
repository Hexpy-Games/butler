import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { CopyButton } from "../../components/CopyButton";
import { Grid } from "../../components/Grid";
import { DoneIconButton } from "../../components/DoneIconButton";
import { Scrap } from "../../components/Icons";
import { MediaFrame } from "../../components/MediaFrame";
import { BROKEN_PICTURE, fixturePicture } from "../../components/MediaFrame/fixtures";
import { Stack } from "../../components/Stack";
import { fixtureItems, fixtureSave, LABELS, type FixtureItem } from "./fixtures";
import { ItemCard, type ItemCardProps } from "./ItemCard";
import { SkeletonPair, StreamSettleDemo } from "./ItemCard.demo";
import { ItemCardSkeleton } from "./ItemCardSkeleton";

export const meta: ShowcaseMeta = {
  title: "ItemCard",
  category: "Conversation & Activity",
  tags: ["item", "card", "answer", "result", "picture", "value", "source", "provenance"],
  status: "beta",
};

type Locale = ShowcaseRenderContext["locale"];

/** The container's mapping: a found item → ItemCard props (copy, formatting and commands stay here). */
function props(locale: Locale, item: FixtureItem, src: string | undefined = fixturePicture(item.picture)): ItemCardProps {
  const labels = LABELS[locale];
  return {
    title: item.title, eyebrow: item.eyebrow, subtitle: item.subtitle,
    media: <MediaFrame aspect="4:5" src={src} />,
    value: { ...item.value, wasLabel: labels.before }, facts: item.facts, text: item.text,
    showMoreLabel: labels.more, showLessLabel: labels.less,
    source: { site: item.site, checked: labels.checked, label: `${item.site}, ${labels.open}`, onOpen: () => undefined },
    actions: (
      <>
        <DoneIconButton icon={<Scrap size="sm" />} label={labels.save} doneLabel={labels.saved} onAction={fixtureSave} />
        <CopyButton label={labels.copy} copiedLabel={labels.copied} text={`${item.title} · ${item.value.amount}`} />
      </>
    ),
    onOpen: () => undefined,
    onMediaOpen: () => undefined,
    mediaLabel: item.title,
  };
}

function cards(locale: Locale, count: number) {
  return fixtureItems(locale).slice(0, count).map((item) => <ItemCard key={item.title} {...props(locale, item)} />);
}

/** No picture, a failed picture, title and value only, no footer, a long text that clamps. */
function States({ locale }: ShowcaseRenderContext) {
  const [paper, place, recipe, product, library] = fixtureItems(locale);
  const base = (item: FixtureItem) => props(locale, item);
  return (
    <Grid columns={{ base: "3", compact: "1" }} gap="md">
      <ItemCard {...base(paper!)} media={undefined} />
      <ItemCard {...base(product!)} media={<MediaFrame aspect="4:5" src={BROKEN_PICTURE} />} />
      <ItemCard title={place!.title} value={place!.value} />
      <ItemCard {...base(library!)} source={undefined} actions={undefined} onOpen={undefined} />
      <ItemCard {...base(recipe!)} text={`${recipe!.text} ${recipe!.text} ${recipe!.text}`} />
      <ItemCard {...base(paper!)} eyebrow={undefined} subtitle={undefined} value={undefined} facts={undefined} text={undefined} />
    </Grid>
  );
}

export const stories: ShowcaseStory[] = [
  {
    name: "Answer grid: five unrelated items",
    widths: ["app", "wide"],
    render: ({ locale }) => <Grid columns={{ base: "3", compact: "1" }} gap="md">{cards(locale, 5)}</Grid>,
  },
  {
    name: "Four across: vertical cards below 340px",
    widths: ["app", "wide"],
    render: ({ locale }) => <Grid columns={{ base: "4", compact: "1" }} gap="md">{cards(locale, 4)}</Grid>,
  },
  {
    name: "Two across: rows from 340px",
    widths: ["wide"],
    render: ({ locale }) => <Grid columns={{ base: "2", compact: "1" }} gap="md">{cards(locale, 4)}</Grid>,
  },
  {
    name: "Phone: one column of rows",
    widths: ["320", "375", "430"],
    render: ({ locale }) => <Grid columns="1" gap="md">{cards(locale, 5)}</Grid>,
  },
  { name: "States: no picture, failed picture, minimal, no footer, long text", widths: ["app", "wide"], render: (context) => <States {...context} /> },
  {
    name: "Loading: skeletons hold the next slots",
    widths: ["app", "wide"],
    render: ({ locale }) => (
      <Grid columns={{ base: "4", compact: "1" }} gap="sm" cross="start">
        {cards(locale, 2)}
        <ItemCardSkeleton media="4:5" />
        <ItemCardSkeleton media="4:5" />
      </Grid>
    ),
  },
  { name: "Loading: the skeleton is the box of the card it becomes", widths: ["375", "app", "wide"], render: (context) => <SkeletonPair {...context} /> },
  { name: "Loading: without a picture", widths: ["375", "app"], render: (context) => <SkeletonPair {...context} media={null} /> },
  { name: "Settle: cards stream in, the grid settles once at close", widths: ["375", "app", "wide"], render: (context) => <div data-ds-async style={{ display: "contents" }}><StreamSettleDemo {...context} /></div> },
  {
    name: "Reduced motion: fades only, a static skeleton, the height at once",
    widths: ["375", "app"],
    render: (context) => <div data-ds-async style={{ display: "contents" }}><Stack data-motion="reduced"><StreamSettleDemo {...context} reducedMotion /></Stack></div>,
  },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible"],
  render: ({ locale }) => <ItemCard {...props(locale, fixtureItems(locale)[2]!)} />,
};
