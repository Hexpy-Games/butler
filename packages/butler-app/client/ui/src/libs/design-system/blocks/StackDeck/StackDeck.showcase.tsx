import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { StackDeck, type StackDeckCardContext, type StackDeckItem } from "./StackDeck";
import type { StackDeckLabels } from "./stackDeckLabels";

export const meta: ShowcaseMeta = {
  title: "StackDeck",
  category: "Conversation & Activity",
  tags: ["stack", "deck", "묶음", "cards", "fan", "scroll-snap", "motion"],
  status: "beta",
};

interface DeckCard extends StackDeckItem {
  caption: string;
}

const COPY = {
  "en-US": {
    titles: ["Draft the API", "Write the migration", "Update the client", "Add sync tests", "Review copy", "Release notes"],
    captions: ["Reading 3 files", "Waiting", "Editing api.ts", "Waiting", "Waiting", "Waiting"],
    more: (count: number) => `+${count} more`,
  },
  "ko-KR": {
    titles: ["API 초안", "마이그레이션 작성", "클라이언트 수정", "동기화 테스트 추가", "문구 검토", "릴리스 노트"],
    captions: ["파일 3개 읽는 중", "대기", "api.ts 수정 중", "대기", "대기", "대기"],
    more: (count: number) => `외 ${count}건`,
  },
} as const;

/** Korean accessible names, as a product container passes them. */
const KO_DECK_LABELS: Partial<StackDeckLabels> = {
  expand: (count, front) => `${front} 외 ${count - 1}건, 펼치기`,
  fold: (item) => `${item}, 접기`,
};

function deckLabels(context: ShowcaseRenderContext): Partial<StackDeckLabels> | undefined {
  return context.locale === "ko-KR" ? KO_DECK_LABELS : undefined;
}

function cards(context: ShowcaseRenderContext, count: number, running: number[] = []): DeckCard[] {
  const copy = COPY[context.locale];
  return copy.titles.slice(0, count).map((title, index) => ({
    id: `card-${index}`, label: title, caption: copy.captions[index]!, running: running.includes(index),
  }));
}

/** The front's count (“외 N건”) sits outside the truncating title, so it always shows. */
function cardRenderer(context: ShowcaseRenderContext) {
  return (item: DeckCard, { index, count, expanded }: StackDeckCardContext) => (
    <Stack gap="xs">
      <Stack align="row" gap="xs">
        <Typo.Body truncate>{item.label}</Typo.Body>
        {!expanded && index === 0 && count > 1 ? <Typo.Body tone="tertiary" wrap="nowrap" shrink={false}>{COPY[context.locale].more(count - 1)}</Typo.Body> : null}
      </Stack>
      <Typo.Caption tone="secondary" truncate>{item.caption}</Typo.Caption>
    </Stack>
  );
}

function Deck({ context, count, running, expanded }: { context: ShowcaseRenderContext; count: number; running?: number[]; expanded?: boolean }) {
  return (
    <StackDeck items={cards(context, count, running)} renderCard={cardRenderer(context)} defaultExpanded={expanded} labels={deckLabels(context)} />
  );
}

export const stories: ShowcaseStory[] = [
  // Tap the deck (or Enter/Space on it): the cards slide out from behind the front card, a stagger step apart.
  // Two, three and four cards: one edge per card behind the front.
  {
    name: "Collapsed",
    states: ["default"],
    widths: ["320", "375", "app"],
    render: (context) => (
      <Stack gap="md">
        <Deck context={context} count={2} />
        <Deck context={context} count={3} />
        <Deck context={context} count={4} />
      </Stack>
    ),
  },
  // Two whole cards per view; 140 ms after a scroll stops the row settles on a whole card. Tap a card (or Escape) to stack them again.
  { name: "Fanned", states: ["open"], widths: ["320", "375", "app"], render: (context) => <Deck context={context} count={3} expanded /> },
  {
    name: "Running items",
    widths: ["375", "app"],
    render: (context) => (
      <Stack gap="md">
        <Deck context={context} count={3} running={[0, 2]} />
        <Deck context={context} count={3} running={[0, 2]} expanded />
      </Stack>
    ),
  },
  // Six cards: three edges collapsed; fanned, a mirrored edge per card out of view at either end, the fades only while scrolling.
  {
    name: "Four or more cards (edge markers)",
    widths: ["320", "375", "app"],
    render: (context) => (
      <Stack gap="md">
        <Deck context={context} count={6} running={[2]} />
        <Deck context={context} count={6} running={[2]} expanded />
      </Stack>
    ),
  },
  { name: "Single card", render: (context) => <Deck context={context} count={1} /> },
];
