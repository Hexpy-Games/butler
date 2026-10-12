import { useLayoutEffect, useRef, useState } from "react";
import type { CardsBlock, CardItem } from "../../../../shared/app-contracts";
import { Button, Collapsible, CopyButton, Grid, IconButton, ItemCard, Library, MediaFrame, Stack } from "@/butler-ds";
import { openLink } from "../browser/browserBridge";
import { useAppLocale } from "@/app/copy";
import { answerCardCopy, answerSource, runAnswerAction, saveAnswerItem } from "./answerBlockActions";
import { formatAnswerValue } from "./answerValueFormat";

function AnswerCard({ item, media }: { item: CardItem; media: CardsBlock["media"] }) {
  const locale = useAppLocale();
  return <ItemCard title={item.title} eyebrow={item.label} subtitle={item.sub}
    media={<MediaFrame aspect={media ?? "4:5"} src={item.img ? `/assets/${encodeURIComponent(item.img)}` : undefined} alt={item.title} />}
    value={item.value ? { amount: formatAnswerValue(item.value, locale), was: item.value.was === undefined ? undefined : formatAnswerValue(item.value, locale, item.value.was), wasLabel: "이전", note: item.value.note } : undefined}
    facts={item.facts} text={item.text} showMoreLabel="더 보기" showLessLabel="접기" source={answerSource(item)}
    onOpen={item.source ? () => runAnswerAction(() => openLink(item.source!)) : undefined}
    actions={<><IconButton label="서랍에 저장" onClick={() => runAnswerAction(() => saveAnswerItem(item))}><Library size="sm" /></IconButton>
      <CopyButton label="복사" copiedLabel="복사했어요" text={answerCardCopy(item)} /></>} />;
}

/** Width is observed on the grid itself, including beside an open browser panel. */
function useCardColumns(count: number) {
  const ref = useRef<HTMLElement>(null);
  const [columns, setColumns] = useState<"1" | "2" | "3" | "4">("1");
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      const width = node.getBoundingClientRect().width;
      const gap = Number.parseFloat(getComputedStyle(node).columnGap) || 0;
      let n = width < 560 ? 1 : Math.min(4, count, Math.floor((width + gap) / (168 + gap)));
      while (n > 1 && count % n === 1) n--;
      setColumns(String(Math.max(1, n)) as typeof columns);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [count]);
  return { ref, columns };
}

export function AnswerCards({ block }: { block: CardsBlock }) {
  const [expanded, setExpanded] = useState(false);
  const { ref, columns } = useCardColumns(expanded ? block.items.length : Math.min(6, block.items.length));
  const cards = (items: CardItem[], offset = 0) => items.map((item, index) => <AnswerCard key={`${offset + index}:${item.key ?? item.title}`} item={item} media={block.media} />);
  return <Stack gap="sm">
    {!expanded ? <Grid ref={ref} gap="sm" columns={columns} data-test-class="answer-cards">{cards(block.items.slice(0, 6))}</Grid> : null}
    <Collapsible open={expanded}><Grid ref={expanded ? ref : undefined} gap="sm" columns={columns} data-test-class="answer-cards">{cards(block.items)}</Grid></Collapsible>
    {block.items.length > 6 ? <Button variant="inline" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      {expanded ? "접기" : `${block.items.length - 6}개 더 보기`}</Button> : null}
  </Stack>;
}
