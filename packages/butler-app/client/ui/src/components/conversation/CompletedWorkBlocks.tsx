import { memo } from "react";
import type { WorkBlockView } from "@/app/types.ts";
import { CollapsedTurnActivity } from "./WorkBlocks";

export const CompletedWorkBlocks = memo(function CompletedWorkBlocks({
  blocks,
  defaultExpanded = false,
}: {
  blocks: WorkBlockView[] | undefined;
  defaultExpanded?: boolean;
}) {
  if (!blocks?.length) return null;
  return (
    <CollapsedTurnActivity
      blocks={blocks}
      defaultExpanded={defaultExpanded}
    />
  );
});
