import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AnswerCardsView, AnswerCardView } from "../../../../shared/answer-blocks-view";
import { Button, Collapsible, CopyButton, Grid, IconButton, ItemCard, Library, MediaFrame, Stack } from "@/butler-ds";
import { appCopy, useAppLocale } from "@/app/copy";
import { openConversationLink } from "../browser/browserBridge";
import { openImageViewer, type ViewerImage } from "../media/imageViewerState";
import { answerCardCopy, answerImages, answerPart, answerSource, runAnswerAction, saveAnswerItem, useAnswerSession } from "./answerBlockActions";
import { formatAnswerValue } from "./answerValueFormat";

/** The card opens its source page in the conversation's browser; its picture opens the viewer on the block's pictures. */
const AnswerCard = memo(function AnswerCard({ item, media, images, index }: { item: AnswerCardView; media: AnswerCardsView["media"]; images: ViewerImage[]; index: number }) {
  const locale = useAppLocale();
  const sessionId = useAnswerSession();
  const copy = appCopy.conversation.answerBlocks;
  const source = answerSource(item, sessionId);
  const picture = images[index]?.src;
  return <ItemCard title={item.title} eyebrow={item.label} subtitle={item.sub}
    media={<MediaFrame aspect={media ?? "1:1"} fit="cover" placeholder placeholderIcon={source?.icon}
      src={picture || undefined} alt={item.title} />}
    onMediaOpen={picture ? () => openImageViewer(images, index) : undefined}
    mediaLabel={appCopy.conversation.imageViewer.viewImage(item.title)}
    value={item.value ? { amount: formatAnswerValue(item.value, locale), was: item.value.was === undefined ? undefined : formatAnswerValue(item.value, locale, item.value.was), wasLabel: copy.previousValue, note: item.value.note } : undefined}
    facts={item.facts} text={item.text} showMoreLabel={copy.showMore} showLessLabel={copy.showLess} source={source}
    onOpen={item.source ? () => runAnswerAction(() => openConversationLink(item.source!, sessionId)) : undefined}
    actions={<><IconButton label={copy.saveToLibrary} onClick={(event) => { const part = answerPart(event.currentTarget); runAnswerAction(() => saveAnswerItem(item, sessionId, part)); }}><Library size="sm" /></IconButton>
      <CopyButton label={copy.copy} copiedLabel={copy.copied} text={answerCardCopy(item)} /></>} />;
});

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

export const AnswerCards = memo(function AnswerCards({ block }: { block: AnswerCardsView }) {
  useAppLocale();
  const [expanded, setExpanded] = useState(false);
  const copy = appCopy.conversation.answerBlocks;
  const { ref, columns } = useCardColumns(expanded ? block.items.length : Math.min(6, block.items.length));
  const sessionId = useAnswerSession();
  const images = useMemo(() => answerImages(block.items, sessionId, copy.image), [block.items, sessionId, copy.image]);
  const cards = (items: AnswerCardView[], offset = 0) => items.map((item, index) => <AnswerCard key={item.key ?? offset + index}
    item={item} media={block.media} images={images} index={offset + index} />);
  return <Stack gap="sm">
    {!expanded ? <Grid ref={ref} gap="sm" columns={columns} data-test-class="answer-cards">{cards(block.items.slice(0, 6))}</Grid> : null}
    <Collapsible open={expanded}><Grid ref={expanded ? ref : undefined} gap="sm" columns={columns} data-test-class="answer-cards">{cards(block.items)}</Grid></Collapsible>
    {block.items.length > 6 ? <Button variant="inline" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      {expanded ? copy.showLess : copy.showMoreItems(block.items.length - 6)}</Button> : null}
  </Stack>;
});
