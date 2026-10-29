import type { ReactNode } from "react";
import type { AnswerContainerView, AnswerLeafView } from "../../../../shared/answer-blocks-view";
import { BlockColumns, BlockTabs, Stack } from "@/butler-ds";

export function AnswerContainers({ block, render }: { block: AnswerContainerView; render: (leaf: AnswerLeafView, path: string) => ReactNode }) {
  const children = (leaves: AnswerLeafView[], prefix = "") => leaves.map((leaf, index) =>
    <Stack key={leaf.id ?? index} gap="sm">{render(leaf, `${prefix}/blocks/${index}`)}</Stack>);
  if (block.type === "columns") return <BlockColumns>{children(block.blocks)}</BlockColumns>;
  if (block.type === "tabs") return <BlockTabs ariaLabel={block.title} tabs={block.tabs.map((tab, index) => ({ label: tab.label, content: <Stack gap="md">{children(tab.blocks, `/tabs/${index}`)}</Stack> }))} />;
  return <Stack gap="md">{children(block.blocks)}</Stack>;
}
