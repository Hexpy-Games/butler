import { memo, useMemo } from "react";
import type { AnswerBlock, AnswerBlockSet } from "../../../../shared/app-contracts";
import { parseAnswerBlocks } from "../../../../shared/answer-blocks-parse";
import { Button, Popup, Inline, KeyValueRow, MetricCard, MetricGrid, Notice, PillButton, Presence, Reply, Stack, Typo } from "@/butler-ds";
import { useButlerStore } from "@/app/store";
import { openLink } from "../browser/browserBridge";
import { AnswerCards } from "./AnswerCards";
import { AnswerChart, AnswerGallery, AnswerSourceLine, AnswerTable } from "./AnswerDataBlocks";
import { runAnswerAction } from "./answerBlockActions";

function Block({ block }: { block: AnswerBlock }) {
  const sendMessage = useButlerStore(state => state.sendMessage);
  switch (block.type) {
    case "cards": return <AnswerCards block={block} />;
    case "table": return <AnswerTable block={block} />;
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
      : <Button key={index} variant="secondary" iconStart={<Popup size="sm" />} onClick={() => runAnswerAction(() => openLink(item.open))}>{item.label}</Button>)}</Inline>;
  }
}

/** Domain records are parsed once per snapshot; all presentation belongs to DS blocks. */
export const AnswerBlocks = memo(function AnswerBlocks({ sets }: { sets?: AnswerBlockSet[] }) {
  const parsed = useMemo(() => sets?.flatMap(set => {
    const spec = parseAnswerBlocks(set?.spec);
    return spec ? [{ call: set.call_id, spec }] : [];
  }) ?? [], [sets]);
  if (!parsed.length) return null;
  return <Presence present motion="fade"><Stack gap="md" data-test-class="answer-blocks">
    {parsed.map((set, setIndex) => <Stack key={`${setIndex}:${set.call}`} gap="md">
      {set.spec.blocks.map((block, index) => <Stack key={`${index}:${block.id ?? block.type}`} gap="sm" data-answer-block={block.type}>
        {block.title ? <Typo.SectionTitle>{block.title}</Typo.SectionTitle> : null}
        <Block block={block} />
      </Stack>)}
    </Stack>)}
  </Stack></Presence>;
});
