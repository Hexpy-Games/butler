// Showcase demos: answer cards that stream in one by one, then settle once when the list closes.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { ShowcaseRenderContext } from "../../showcase";
import { Button } from "../../components/Button";
import { CopyButton } from "../../components/CopyButton";
import { Grid } from "../../components/Grid";
import { IconButton } from "../../components/IconButton";
import { Scrap } from "../../components/Icons";
import { MediaFrame } from "../../components/MediaFrame";
import { useLateSrc } from "../../components/MediaFrame/MediaFrame.demo";
import { FIXTURE_FAVICON, fixturePicture } from "../../components/MediaFrame/fixtures";
import { Presence } from "../../components/Presence";
import { Stack } from "../../components/Stack";
import { settleGrid } from "../../lib/gridSettle";
import { fixtureItems, LABELS, type FixtureItem } from "./fixtures";
import { ItemCard } from "./ItemCard";
import { ItemCardSkeleton } from "./ItemCardSkeleton";

type Locale = ShowcaseRenderContext["locale"];
type Columns = "1" | "2" | "3" | "4";

const COPY = {
  "en-US": { replay: "Replay", loading: "Loading answer cards" },
  "ko-KR": { replay: "다시 보기", loading: "답변 카드를 준비하는 중" },
} as const;

/** One card of the stream: its picture arrives a moment after the card, as over a network. */
function StreamCard({ locale, item, round, reducedMotion }: { locale: Locale; item: FixtureItem; round: number; reducedMotion?: boolean }) {
  const labels = LABELS[locale];
  const src = useLateSrc(fixturePicture(item.picture), 450, round);
  return (
    <Presence present motion="rise">
      <ItemCard title={item.title} eyebrow={item.eyebrow} subtitle={item.subtitle} facts={item.facts} value={{ ...item.value, wasLabel: labels.before }}
        media={<MediaFrame aspect="1:1" fit="cover" placeholder={src !== undefined} placeholderIcon={FIXTURE_FAVICON} src={src} reducedMotion={reducedMotion} />}
        source={{ site: item.site, checked: labels.checked, label: `${item.site}, ${labels.open}`, onOpen: () => undefined }}
        actions={<><IconButton label={labels.save}><Scrap size="sm" /></IconButton><CopyButton label={labels.copy} copiedLabel={labels.copied} text={item.title} /></>}
        onOpen={() => undefined} />
    </Presence>
  );
}

/** Columns from the grid's width alone while the list is open: one below 560px, else 168px cells, at most four. */
function useWidthColumns(grid: RefObject<HTMLElement | null>): number {
  const [columns, setColumns] = useState(4);
  useLayoutEffect(() => {
    const node = grid.current;
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    const measure = () => {
      const width = node.getBoundingClientRect().width;
      const gap = Number.parseFloat(window.getComputedStyle(node).columnGap) || 0;
      setColumns(width < 560 ? 1 : Math.max(1, Math.min(4, Math.floor((width + gap) / (168 + gap)))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [grid]);
  return columns;
}

/** The lone-card rule: no last row with a single card (5 cards: 3 + 2, not 4 + 1). */
function finalColumns(columns: number, count: number): number {
  let n = Math.min(columns, count);
  while (n > 1 && count % n === 1) n -= 1;
  return Math.max(1, n);
}

/**
 * Five cards arrive one by one into width-driven columns; a skeleton holds the next slot and cells keep their
 * own height (cross="start"). At close the lone-card rule gives the final columns (3 + 2 instead of 4 + 1) and
 * rows share their height: one settle, the dip hiding the reflow.
 */
export function StreamSettleDemo({ locale, reducedMotion }: ShowcaseRenderContext & { reducedMotion?: boolean }) {
  const items = fixtureItems(locale);
  const grid = useRef<HTMLElement>(null);
  const live = useWidthColumns(grid);
  const liveRef = useRef(live);
  liveRef.current = live;
  const [round, setRound] = useState(0);
  const [count, setCount] = useState(0);
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    setCount(0);
    setClosed(false);
    const timers = items.map((_, index) => window.setTimeout(() => setCount(index + 1), 500 + index * 700));
    timers.push(window.setTimeout(() => {
      const reflow = finalColumns(liveRef.current, items.length) !== liveRef.current;
      if (grid.current) settleGrid(grid.current, () => setClosed(true), { reflow, reducedMotion });
    }, 500 + items.length * 700));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [items, round, reducedMotion]);
  const columns = String(closed ? finalColumns(live, items.length) : live) as Columns;
  return (
    <Stack gap="md">
      <Grid ref={grid} columns={columns} gap="sm" cross={closed ? "stretch" : "start"} aria-busy={!closed}>
        {items.slice(0, count).map((item) => <StreamCard key={`${round}:${item.title}`} locale={locale} item={item} round={round} reducedMotion={reducedMotion} />)}
        {closed ? null : <ItemCardSkeleton key={`skeleton:${round}`} media="1:1" label={count === 0 ? COPY[locale].loading : undefined} />}
      </Grid>
      <Stack align="row">
        <Button variant="secondary" size="sm" onClick={() => setRound((value) => value + 1)}>{COPY[locale].replay}</Button>
      </Stack>
    </Stack>
  );
}

/** A card with exactly a subtitle, a one-line title and one line of facts: the parts the skeleton reserves. */
const SHORT = {
  "en-US": { subtitle: "Trail", title: "Lakeside loop", facts: ["4.6 km", "Flat"] },
  "ko-KR": { subtitle: "산책로", title: "호숫가 산책로", facts: ["4.6km", "평지"] },
} as const;

function PairCard({ locale, media }: { locale: Locale; media: "1:1" | null }) {
  const labels = LABELS[locale];
  const short = SHORT[locale];
  const site = "trails.example.org";
  return (
    <ItemCard title={short.title} subtitle={short.subtitle} facts={short.facts}
      media={media ? <MediaFrame aspect={media} fit="cover" src={fixturePicture("place")} /> : undefined}
      source={{ site, checked: labels.checked, label: `${site}, ${labels.open}`, onOpen: () => undefined }}
      actions={<><IconButton label={labels.save}><Scrap size="sm" /></IconButton><CopyButton label={labels.copy} copiedLabel={labels.copied} text={short.title} /></>} />
  );
}

/** Skeletons beside the cards they become, vertical (four across) and as rows (two across): the same boxes. */
export function SkeletonPair({ locale, media = "1:1" }: ShowcaseRenderContext & { media?: "1:1" | null }) {
  return (
    <Stack gap="md">
      <Grid columns="4" gap="sm" cross="start">
        <ItemCardSkeleton media={media} />
        <PairCard locale={locale} media={media} />
      </Grid>
      <Grid columns="2" gap="sm" cross="start">
        <ItemCardSkeleton media={media} />
        <PairCard locale={locale} media={media} />
      </Grid>
    </Stack>
  );
}
