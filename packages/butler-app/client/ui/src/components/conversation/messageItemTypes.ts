import type { VirtualItem, Virtualizer } from "@tanstack/react-virtual";
import type { MessageRecord } from "@/app/types.ts";
import type { AssistantFooterMeta } from "./messageFooterMeta";
import type { AnchoredStewardProgress } from "./stewardParentProgressProjection";
import type { LiveTurnActivity } from "./TurnActivityPanel";

export interface MessageItemProps {
  message: MessageRecord;
  liveActivity?: LiveTurnActivity;
  /** Its turn is still running in the separate live activity row after it; that row shows the turn's activity. */
  turnLiveBelow?: boolean;
  virtualRow: VirtualItem;
  topOffset: number;
  copied: boolean;
  /** Newly inserted row; see useEnteringKeys. */
  entering?: boolean | "delivered";
  footerMeta: AssistantFooterMeta | null;
  onCopyAssistantMessage: (message: MessageRecord) => void;
  onCopyContextMenuText: (message: MessageRecord) => void;
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
  stewardProgress?: AnchoredStewardProgress;
}
