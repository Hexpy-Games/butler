import type { ReactNode } from "react";
import type { AnswerContainerView, AnswerLeafView } from "../../../../shared/answer-blocks-view";
import { BlockColumns, BlockTabs, Stack, Typo } from "@/butler-ds";

export function AnswerContainers({ block, render }: { block: AnswerContainerView; render: (leaf: AnswerLeafView) => ReactNode }) {
  const children = (leaves: AnswerLeafView[]) => leaves.map((leaf, index) => <Stack key={leaf.id ?? index} gap="sm" data-answer-block={leaf.type}>
    {leaf.title ? <Typo.Label weight="semibold">{leaf.title}</Typo.Label> : null}{render(leaf)}
  </Stack>);
  if (block.type === "columns") return <BlockColumns>{children(block.blocks)}</BlockColumns>;
  if (block.type === "tabs") return <BlockTabs ariaLabel={block.title} tabs={block.tabs.map(tab => ({ label: tab.label, content: <Stack gap="md">{children(tab.blocks)}</Stack> }))} />;
  return <Stack gap="md">{children(block.blocks)}</Stack>;
}
