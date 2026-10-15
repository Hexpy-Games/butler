import { memo, useMemo, useRef, useState } from "react";
import type { AnswerCardsView, AnswerCardView } from "../../../../shared/answer-blocks-view";
import { Button, Collapsible, CopyButton, DoneIconButton, Grid, ItemCard, Library, MediaFrame, ItemCardSkeleton, Stack } from "@/butler-ds";
import { appCopy, useAppLocale } from "@/app/copy";
import { openConversationLink } from "../browser/browserBridge";
import { openImageViewer, type ViewerImage } from "../media/imageViewerState";
import { answerActionFailed, answerCardCopy, answerImages, answerPart, answerSource, runAnswerAction, saveAnswerItem, useAnswerSession } from "./answerBlockActions";
import { useButlerStore } from "@/app/store";
import { useAnswerCardGrid } from "./useAnswerCardGrid";
import { AnswerItem } from "./AnswerItem";
import { formatAnswerValue } from "./answerValueFormat";

/** The card opens its source page in the conversation's browser; its picture opens the viewer on the block's pictures. */
const AnswerCard = memo(function AnswerCard({ item, media, images, picture, index }: { item: AnswerCardView; media: AnswerCardsView["media"]; images: { current: ViewerImage[] }; picture?: string; index: number }) {
  const locale = useAppLocale();
  const sessionId = useAnswerSession();
  const copy = appCopy.conversation.answerBlocks;
  const source = answerSource(item, sessionId);
  const reducedMotion = useButlerStore(state => state.settings.reduce_motion);

  return <ItemCard title={item.title} eyebrow={item.label} subtitle={item.sub}
    media={<MediaFrame aspect={media ?? "1:1"} fit="cover" placeholder placeholderIcon={source?.icon}
      src={picture || undefined} alt={item.title} reducedMotion={reducedMotion || undefined} />}
    onMediaOpen={picture ? () => openImageViewer(images.current, index) : undefined}
    mediaLabel={appCopy.conversation.imageViewer.viewImage(item.title)}
    value={item.value ? { amount: formatAnswerValue(item.value, locale), was: item.value.was === undefined ? undefined : formatAnswerValue(item.value, locale, item.value.was), wasLabel: copy.previousValue, note: item.value.note } : undefined}
    facts={item.facts} text={item.text} showMoreLabel={copy.showMore} showLessLabel={copy.showLess} source={source}
    onOpen={item.source ? () => runAnswerAction(() => openConversationLink(item.source!, sessionId)) : undefined}
    actions={<><DoneIconButton icon={<Library size="sm" />} label={copy.saveToLibrary} doneLabel={copy.savedToLibrary} announce={false}
      onAction={(event) => saveAnswerItem(item, sessionId, answerPart(event.currentTarget))} onError={answerActionFailed} />
      <CopyButton label={copy.copy} copiedLabel={copy.copied} text={answerCardCopy(item)} /></>} />;
});

export const AnswerCards = memo(function AnswerCards({ block, streaming = false, incoming }: { block: AnswerCardsView; streaming?: boolean; incoming?: unknown[] }) {
  useAppLocale();
  const [expanded, setExpanded] = useState(false);
  const copy = appCopy.conversation.answerBlocks;
  const reducedMotion = useButlerStore(state => state.settings.reduce_motion);
  const { ref, columns, settled } = useAnswerCardGrid(expanded ? block.items.length : Math.min(6, block.items.length), streaming, reducedMotion);
  const sessionId = useAnswerSession();
  const images = useMemo(() => answerImages(block.items, sessionId, copy.image), [block.items, sessionId, copy.image]);
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const cards = (items: AnswerCardView[], offset = 0) => items.map((item, index) => <AnswerItem key={item.key ?? offset + index} superseded={incoming !== undefined && !incoming.includes(item)}><AnswerCard item={item} media={block.media} images={imagesRef}
      picture={images[offset + index]?.src} index={offset + index} /></AnswerItem>);
  return <Stack gap="sm">
    {!expanded ? <Grid ref={ref} gap="sm" columns={columns} cross={settled ? "stretch" : "start"} data-motion={reducedMotion ? "reduced" : undefined} data-test-class="answer-cards">{cards(block.items.slice(0, 6))}{streaming ? <ItemCardSkeleton media={block.media} /> : null}</Grid> : null}
    <Collapsible open={expanded}><Grid ref={expanded ? ref : undefined} gap="sm" columns={columns} cross={settled ? "stretch" : "start"} data-motion={reducedMotion ? "reduced" : undefined} data-test-class="answer-cards">{cards(block.items)}{streaming ? <ItemCardSkeleton media={block.media} /> : null}</Grid></Collapsible>
    {block.items.length > 6 ? <Button variant="inline" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      {expanded ? copy.showLess : copy.showMoreItems(block.items.length - 6)}</Button> : null}
  </Stack>;
});
