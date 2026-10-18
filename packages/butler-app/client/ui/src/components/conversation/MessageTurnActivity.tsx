import { useState } from "react";
import { projectTurnActivity } from "@/app/conversation-progress";
import { useAppLocale } from "@/app/copy";
import type { MessageRecord } from "@/app/types";
import { Collapsible, Stack } from "@/butler-ds";
import { TurnActivityStatus, TurnActivityWork, type LiveTurnActivity } from "./TurnActivityPanel";

/**
 * The message's activity slot, above its text. Live progress and the settled summary
 * render through the same tree, so on completion the header stays and the current step folds.
 */
export function MessageTurnActivity({ message, live }: { message: MessageRecord; live?: LiveTurnActivity }) {
  useAppLocale();
  const turnId = live ? live.turnId : message.turn_id;
  const projection = projectTurnActivity(live?.rows ?? message.turn_activity_rows ?? [], turnId);
  return <TurnActivityWork projection={projection} live={Boolean(live)}
    currentState={live ? projection.semanticState : message.status} turnId={turnId} />;
}

/** The live status line below the message text; it folds away when the turn settles. */
export function MessageLiveStatus({ live }: { live?: LiveTurnActivity }) {
  // Keep the last live status so the fold shows it while it closes.
  const [shown, setShown] = useState(live);
  if (live && live !== shown) setShown(live);
  return (
    <Collapsible open={Boolean(live)} data-test-class="turn-live-status">
      {/* A flex column keeps the inline status label the same height it has as a body row. */}
      <Stack gap="none">{shown ? <TurnActivityStatus {...shown} /> : null}</Stack>
    </Collapsible>
  );
}
