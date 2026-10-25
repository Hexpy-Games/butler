import { memo, useMemo } from "react";
import type { AnswerBlockSet } from "../../../../shared/app-contracts";
import type { AnswerBlockView } from "../../../../shared/answer-blocks-view";
import { parseAnswerBlocks } from "../../../../shared/answer-blocks-parse";
import { answerMetricTrend } from "../../../../shared/answer-metric-trend";
import { Button, Popup, Inline, KeyValueRow, MetricCard, MetricGrid, Notice, PillButton, Presence, usePresence, Reply, ItemCardSkeleton, Skeleton, Stack } from "@/butler-ds";
import { useAppLocale } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import { useAnswerDrafts, draftBlocks } from "@/app/answerDrafts";
import { openConversationLink } from "../browser/browserBridge";
import { AnswerItem } from "./AnswerItem";
import { AnswerCards } from "./AnswerCards";
import { AnswerChart, AnswerGallery, AnswerSourceLine, AnswerTable } from "./AnswerDataBlocks";
import { AnswerSessionContext, runAnswerAction, useAnswerSession } from "./answerBlockActions";
import { AnswerLeafBlocks } from "./AnswerLeafBlocks";
import { AnswerBlockFrame, AnswerBlockOriginContext, type AnswerBlockOrigin } from "./AnswerBlockFrame";
import { AnswerContainers } from "./AnswerContainers";

const Block = memo(function Block({ block, path, streaming, incoming }: { block: AnswerBlockView; path: string; streaming?: boolean; incoming?: unknown[] }) {
  const sendMessage = useButlerStore(state => state.sendMessage);
  const sessionId = useAnswerSession();
  switch (block.type) {
    case "columns": case "tabs": case "group": return <AnswerContainers block={block} render={(leaf, suffix) => <AnswerBlockFrame block={leaf} path={`${path}${suffix}`} child><Block block={leaf} path={`${path}${suffix}`} /></AnswerBlockFrame>} />;
    case "timeline": case "checklist": case "progress": case "text": case "image": case "quote": return <AnswerLeafBlocks block={block} />;
    case "cards": return <AnswerCards block={block} streaming={streaming} incoming={incoming} />;
    case "table": return <AnswerTable block={block} streaming={streaming} incoming={incoming} />;
    case "gallery": return <AnswerGallery block={block} incoming={incoming} />;
    case "facts": return <Stack gap="xs">{block.items.map((item, index) =>
      <AnswerItem key={index} superseded={incoming !== undefined && !incoming.includes(item)}><KeyValueRow label={item.label} value={item.value} description={<AnswerSourceLine item={item} />} /></AnswerItem>)}</Stack>;
    case "metrics": return <MetricGrid>{block.items.map((item, index) => <AnswerItem key={index} superseded={incoming !== undefined && !incoming.includes(item)}><Stack gap="xs">
      <MetricCard label={item.label} value={[item.value, item.unit].filter(value => value !== undefined).join(" ")}
        change={item.delta} trend={answerMetricTrend(item.delta, item.direction)} />
      <AnswerSourceLine item={item} />
    </Stack></AnswerItem>)}</MetricGrid>;
    case "chart": return <AnswerChart block={block} />;
    case "callout": return <Notice tone={block.tone ?? "neutral"} message={block.text} />;
    case "actions": return <Inline>{block.items.map((item, index) => <AnswerItem key={index} superseded={incoming !== undefined && !incoming.includes(item)}>{"ask" in item
      ? <PillButton surface="glass" icon={<Reply size="sm" />} onClick={() => runAnswerAction(() => sendMessage(item.ask))}>{item.ask}</PillButton>
      : <Button variant="secondary" iconStart={<Popup size="sm" />} onClick={() => runAnswerAction(() => openConversationLink(item.open, sessionId))}>{item.label}</Button>}</AnswerItem>)}</Inline>;
  }
});

/** Domain records are parsed once per changed block snapshot; all presentation belongs to DS blocks. */
export const AnswerBlocks = memo(function AnswerBlocks({ sets, sessionId, turnId, messageId, replyText, saved, preview }: { sets?: AnswerBlockSet[]; sessionId?: string; turnId?: string; messageId?: string; replyText?: string; saved?: boolean; preview?: boolean }) {
  const parsed = useMemo(() => sets?.flatMap(set => {
    const spec = parseAnswerBlocks(set?.spec);
    return spec ? spec.blocks : [];
  }) ?? [], [sets]);
  useAppLocale();
  const reducedMotion = useButlerStore(state => state.settings.reduce_motion);
  const draft = useAnswerDrafts(state => turnId ? state.answerDrafts[turnId] : undefined);
  const final = parsed.length > 0;
  const origin = useMemo<AnswerBlockOrigin>(() => ({ session: sessionId, message: messageId, reply: replyText, saved, preview: preview || !messageId || !final }), [sessionId, messageId, replyText, saved, preview, final]);
  const present = final || draft?.present === true;
  const presence = usePresence(present);
  const entries = useMemo(() => draft ? draftBlocks(draft) : [], [draft]);
  const rendered = final ? parsed : entries.map(entry => entry.view ?? entry.raw);
  if (!rendered.length) return null;
  return <AnswerBlockOriginContext.Provider value={origin}><AnswerSessionContext.Provider value={sessionId}><Presence present={present} motion="fade"><div ref={presence.ref} data-test-class="answer-blocks" data-motion={reducedMotion ? "reduced" : undefined}><Stack gap="md">
    {rendered.map((raw, index) => {
      const block = raw as AnswerBlockView;
      const entry = final ? undefined : entries[index];
      const ready = final || Boolean(entry?.view);
      const streaming = entry?.open === true;
      const incoming = entry?.incoming;
      return <AnswerBlockFrame key={block.id ?? `${index}:${block.type}`} block={block} path={`/blocks/${index}`}>
        {ready ? <Block block={block} path={`/blocks/${index}`} streaming={streaming} incoming={incoming} /> : block.type === "cards" ? <ItemCardSkeleton media={block.media} /> : <Skeleton height="row" width="full" />}
        {streaming && ready && block.type !== "cards" && block.type !== "table" ? <Skeleton height="row" width="full" /> : null}
      </AnswerBlockFrame>;
    })}
  </Stack></div></Presence></AnswerSessionContext.Provider></AnswerBlockOriginContext.Provider>;
});
