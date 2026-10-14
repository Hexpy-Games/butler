import { memo, useEffect, useMemo } from "react";
import type { AnswerBlockSet } from "../../../../shared/app-contracts";
import type { AnswerBlockView } from "../../../../shared/answer-blocks-view";
import { parseAnswerBlocks } from "../../../../shared/answer-blocks-parse";
import { Button, Popup, Inline, KeyValueRow, MetricCard, MetricGrid, Notice, PillButton, Presence, usePresence, Reply, Skeleton, Stack, Typo } from "@/butler-ds";
import { appCopy, useAppLocale } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import { useAnswerDrafts, forgetAnswerDraft } from "@/app/answerDrafts";
import { openConversationLink } from "../browser/browserBridge";
import { AnswerCards } from "./AnswerCards";
import { AnswerChart, AnswerGallery, AnswerSourceLine, AnswerTable } from "./AnswerDataBlocks";
import { AnswerSessionContext, runAnswerAction, useAnswerSession } from "./answerBlockActions";

const Block = memo(function Block({ block, streaming }: { block: AnswerBlockView; streaming?: boolean }) {
  const sendMessage = useButlerStore(state => state.sendMessage);
  const sessionId = useAnswerSession();
  switch (block.type) {
    case "cards": return <AnswerCards block={block} streaming={streaming} />;
    case "table": return <AnswerTable block={block} streaming={streaming} />;
    case "gallery": return <AnswerGallery block={block} />;
    case "facts": return <Stack gap="xs">{block.items.map((item, index) =>
      <KeyValueRow key={index} label={item.label} value={item.value} description={<AnswerSourceLine item={item} />} />)}</Stack>;
    case "metrics": return <MetricGrid>{block.items.map((item, index) => <Stack key={index} gap="xs">
      <MetricCard label={item.label} value={[item.value, item.unit].filter(value => value !== undefined).join(" ")}
        change={item.delta} trend={item.delta?.startsWith("-") ? "down" : item.delta?.startsWith("+") ? "up" : "neutral"} />
      <AnswerSourceLine item={item} />
    </Stack>)}</MetricGrid>;
    case "chart": return <AnswerChart block={block} />;
    case "callout": return <Notice tone={block.tone ?? "neutral"} message={block.text} />;
    case "actions": return <Inline>{block.items.map((item, index) => "ask" in item
      ? <PillButton key={index} surface="glass" icon={<Reply size="sm" />} onClick={() => runAnswerAction(() => sendMessage(item.ask))}>{item.ask}</PillButton>
      : <Button key={index} variant="secondary" iconStart={<Popup size="sm" />} onClick={() => runAnswerAction(() => openConversationLink(item.open, sessionId))}>{item.label}</Button>)}</Inline>;
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
  const draft = useAnswerDrafts(state => turnId ? state.answerDrafts[turnId] : undefined);
  useEffect(() => { if (parsed.length && turnId) forgetAnswerDraft(turnId); }, [parsed, turnId]);
  const final = parsed.length > 0;
  const present = final || draft?.present === true;
  const presence = usePresence(present, { onExitComplete: () => { if (turnId) forgetAnswerDraft(turnId); } });
  const rendered = final ? parsed : draft?.raw.map((raw, index) => draft.blocks[index] ?? raw) ?? [];
  if (!rendered.length) return null;
  return <AnswerSessionContext.Provider value={sessionId}><Presence present={present} motion="fade"><div ref={presence.ref} data-test-class="answer-blocks"><Stack gap="md">
    {!final && draft ? <Typo.Caption tone="secondary" role="status">{draft.outcome === "rejected" ? copy.rechecking
      : draft.outcome === "accepted" ? copy.prepared : copy.preparing}</Typo.Caption> : null}
    {rendered.map((raw, index) => {
      const block = raw as AnswerBlockView;
      const ready = final || Boolean(draft?.blocks[index]);
      const streaming = !final && draft?.open[index];
      return <Stack key={block.id ?? `${index}:${block.type}`} gap="sm" data-answer-block={block.type}>
        {block.title ? <Typo.SectionTitle>{block.title}</Typo.SectionTitle> : null}
        {ready ? <Block block={block} streaming={streaming} /> : <Skeleton height="row" width="full" />}
        {streaming && ready && block.type !== "cards" && block.type !== "table" ? <Skeleton height="row" width="full" /> : null}
      </Stack>;
    })}
  </Stack></div></Presence></AnswerSessionContext.Provider>;
});
