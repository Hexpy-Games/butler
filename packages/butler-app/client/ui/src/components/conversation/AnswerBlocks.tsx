import { memo, useEffect, useMemo } from "react";
import type { AnswerBlockSet } from "../../../../shared/app-contracts";
import type { AnswerBlockView } from "../../../../shared/answer-blocks-view";
import { parseAnswerBlocks } from "../../../../shared/answer-blocks-parse";
import { Button, Popup, Inline, KeyValueRow, MetricCard, MetricGrid, Notice, PillButton, Presence, usePresence, Reply, ItemCardSkeleton, Skeleton, Stack, Typo } from "@/butler-ds";
import { appCopy, useAppLocale } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import { useAnswerDrafts, forgetAnswerDraft, draftBlocks, draftStatus } from "@/app/answerDrafts";
import { openConversationLink } from "../browser/browserBridge";
import { AnswerItem } from "./AnswerItem";
import { AnswerCards } from "./AnswerCards";
import { AnswerChart, AnswerGallery, AnswerSourceLine, AnswerTable } from "./AnswerDataBlocks";
import { AnswerSessionContext, runAnswerAction, useAnswerSession } from "./answerBlockActions";

const Block = memo(function Block({ block, streaming, incoming }: { block: AnswerBlockView; streaming?: boolean; incoming?: unknown[] }) {
  const sendMessage = useButlerStore(state => state.sendMessage);
  const sessionId = useAnswerSession();
  switch (block.type) {
    case "cards": return <AnswerCards block={block} streaming={streaming} incoming={incoming} />;
    case "table": return <AnswerTable block={block} streaming={streaming} incoming={incoming} />;
    case "gallery": return <AnswerGallery block={block} incoming={incoming} />;
    case "facts": return <Stack gap="xs">{block.items.map((item, index) =>
      <AnswerItem key={index} superseded={incoming !== undefined && !incoming.includes(item)}><KeyValueRow label={item.label} value={item.value} description={<AnswerSourceLine item={item} />} /></AnswerItem>)}</Stack>;
    case "metrics": return <MetricGrid>{block.items.map((item, index) => <AnswerItem key={index} superseded={incoming !== undefined && !incoming.includes(item)}><Stack gap="xs">
      <MetricCard label={item.label} value={[item.value, item.unit].filter(value => value !== undefined).join(" ")}
        change={item.delta} trend={item.delta?.startsWith("-") ? "down" : item.delta?.startsWith("+") ? "up" : "neutral"} />
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
export const AnswerBlocks = memo(function AnswerBlocks({ sets, sessionId, turnId }: { sets?: AnswerBlockSet[]; sessionId?: string; turnId?: string }) {
  const parsed = useMemo(() => sets?.flatMap(set => {
    const spec = parseAnswerBlocks(set?.spec);
    return spec ? spec.blocks : [];
  }) ?? [], [sets]);
  useAppLocale();
  const copy = appCopy.conversation.answerBlocks;
  const reducedMotion = useButlerStore(state => state.settings.reduce_motion);
  const draft = useAnswerDrafts(state => turnId ? state.answerDrafts[turnId] : undefined);
  useEffect(() => { if (parsed.length && turnId) forgetAnswerDraft(turnId); }, [parsed, turnId]);
  const final = parsed.length > 0;
  const present = final || draft?.present === true;
  const presence = usePresence(present, { onExitComplete: () => { if (turnId) forgetAnswerDraft(turnId); } });
  const entries = useMemo(() => draft ? draftBlocks(draft) : [], [draft]);
  const rendered = final ? parsed : entries.map(entry => entry.view ?? entry.raw);
  if (!rendered.length) return null;
  return <AnswerSessionContext.Provider value={sessionId}><Presence present={present} motion="fade"><div ref={presence.ref} data-test-class="answer-blocks" data-motion={reducedMotion ? "reduced" : undefined}><Stack gap="md">
    {!final && draft ? <Typo.Caption tone="secondary" role="status">{copy[draftStatus(draft)]}</Typo.Caption> : null}
    {rendered.map((raw, index) => {
      const block = raw as AnswerBlockView;
      const entry = final ? undefined : entries[index];
      const ready = final || Boolean(entry?.view);
      const streaming = entry?.open === true;
      const incoming = entry?.incoming;
      return <Stack key={block.id ?? `${index}:${block.type}`} gap="sm" data-answer-block={block.type}>
        {block.title ? <Typo.SectionTitle>{block.title}</Typo.SectionTitle> : null}
        {ready ? <Block block={block} streaming={streaming} incoming={incoming} /> : block.type === "cards" ? <ItemCardSkeleton media={block.media} /> : <Skeleton height="row" width="full" />}
        {streaming && ready && block.type !== "cards" && block.type !== "table" ? <Skeleton height="row" width="full" /> : null}
      </Stack>;
    })}
  </Stack></div></Presence></AnswerSessionContext.Provider>;
});
