import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AnswerLeafView, AnswerImageView } from "../../../../shared/answer-blocks-view";
import { EventTimeline, EventTimelineItem, Circle, MarkdownContent, MarkdownLink, MarkdownTable, MediaFrame, ProgressMeter, Stack, StatusChecklist, Typo } from "@/butler-ds";
import { appCopy } from "@/app/copy";
import { AnswerSourceLine } from "./AnswerDataBlocks";
import { answerImages, useAnswerSession } from "./answerBlockActions";
import { openImageViewer } from "../media/imageViewerState";

function AnswerImage({ block }: { block: AnswerImageView }) {
  const images = answerImages([block], useAnswerSession(), appCopy.conversation.answerBlocks.image);
  const view = () => { if (images[0]?.src) openImageViewer(images, 0); };
  return <Stack gap="xs">
    <MediaFrame src={images[0]?.src || undefined} aspect="1:1" role="button"
      natural={block.image_width && block.image_height ? { width: block.image_width, height: block.image_height } : undefined}
      aria-disabled={!images[0]?.src || undefined} tabIndex={images[0]?.src ? 0 : undefined}
      aria-label={appCopy.conversation.imageViewer.viewImage(block.caption ?? appCopy.conversation.answerBlocks.image)}
      onClick={view} onKeyDown={event => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); view(); }
      }} alt={block.caption} placeholder />
    {block.caption ? <Typo.Caption>{block.caption}</Typo.Caption> : null}
    <AnswerSourceLine item={block} />
  </Stack>;
}

export function AnswerLeafBlocks({ block }: { block: AnswerLeafView }) {
  switch (block.type) {
    case "timeline": return <EventTimeline>{block.items.map((item, index) => <EventTimelineItem key={index} marker={<Circle size="sm" aria-hidden="true" />}>
      <Stack gap="xs"><Typo.Caption tone="tertiary">{item.when}</Typo.Caption><Typo.Label weight="semibold">{item.title}</Typo.Label>
        {item.text ? <Typo.Body>{item.text}</Typo.Body> : null}<AnswerSourceLine item={item} /></Stack>
    </EventTimelineItem>)}</EventTimeline>;
    case "checklist": return <StatusChecklist items={block.items} />;
    case "progress": return <Stack gap="sm">{block.items.map((item, index) => <Stack key={index} gap="xs">
      <ProgressMeter label={item.label} ariaLabel={item.label} value={item.value / (item.max ?? 100) * 100}
        meta={`${item.value} / ${item.max ?? 100}${item.unit ? ` ${item.unit}` : ""}`} /><AnswerSourceLine item={item} />
    </Stack>)}</Stack>;
    case "text": return <MarkdownContent density="compact"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={["img"]}
      components={{ a: MarkdownLink, table: MarkdownTable }}>{block.text}</ReactMarkdown></MarkdownContent>;
    case "quote": return <Stack gap="xs"><MarkdownContent density="compact"><blockquote><p>{block.text}{block.cite ? ` — ${block.cite}` : ""}</p></blockquote></MarkdownContent><AnswerSourceLine item={block} /></Stack>;
    case "image": return <AnswerImage block={block} />;
    default: return null;
  }
}
