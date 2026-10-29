import { Fragment } from "react";
import { ScrollArea, Separator, Stack } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { useInstructions } from "./hooks/useInstructions";
import type { MemoryCard } from "./memoryTypes";
import { InstructionRow } from "./InstructionRow";
import { MemoryFacts } from "./MemoryFacts";

export function InstructionsContent({ instructions, card, locked }: {
  instructions: ReturnType<typeof useInstructions>; card?: MemoryCard; locked: boolean;
}) {
  const copy = appCopy.settings;
  return <>
    <MemoryFacts card={card} />
    <ScrollArea maxHeight="sm" dataTestClass="instruction-list"><Stack gap="md">
      {instructions.rows.map((item, index) => <Fragment key={item.handle}>
        {index > 0 && <Separator space="none" />}
        <InstructionRow item={item} deleting={instructions.deleting === item.handle}
          locked={Boolean(instructions.deleting) || locked} lockReason={locked ? copy.memory.inUse : undefined}
          onDelete={() => { void instructions.remove(item); }} />
      </Fragment>)}
    </Stack></ScrollArea>
  </>;
}
