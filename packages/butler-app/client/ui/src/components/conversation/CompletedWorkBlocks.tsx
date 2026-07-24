import { memo } from "react";
import type { WorkBlockView } from "@/app/types.ts";
import { CollapsedTurnActivity } from "./WorkBlocks";

export const CompletedWorkBlocks = memo(function CompletedWorkBlocks({
  blocks,
}: {
  blocks: WorkBlockView[] | undefined;
}) {
  if (!blocks?.length) return null;
  return <CollapsedTurnActivity blocks={blocks} />;
});
