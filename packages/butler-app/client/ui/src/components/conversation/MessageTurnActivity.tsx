import { useThinkingRows } from "./useThinkingRows";
import { useState, type ReactNode } from "react";
import { projectTurnActivity } from "@/app/conversation-progress";
import { useAppLocale } from "@/app/copy";
import type { MessageRecord } from "@/app/types";
import { isTerminalProgressState } from "@/app/utils";
import { Collapsible, Space, Stack } from "@/butler-ds";
import { TurnActivityTimeline } from "./TurnActivityTimeline";
import { liveTurnWork, TurnActivityStatus, type LiveTurnActivity } from "./TurnActivityPanel";

/** The last live progress this message carried, kept so its activity can settle and fold in place. */
export function useKeptLiveActivity(live?: LiveTurnActivity): LiveTurnActivity | undefined {
  const [kept, setKept] = useState(live);
  if (live && live !== kept) setKept(live);
  return kept;
}

/**
 * The message's activity timeline, above its text. Live progress and the settled summary
 * render through the same tree, so on completion the header stays and the current step folds.
 * Until the message carries its own activity rows, the last live rows stand in as settled.
 */
export function MessageTurnActivity({ message, live, kept }: {
  message: MessageRecord;
  live?: LiveTurnActivity;
  kept?: LiveTurnActivity;
}) {
  useAppLocale();
  // `undefined` means the message's rows have not arrived yet; `[]` means it has none of its own.
  const settledRows = message.turn_activity_rows ?? kept?.rows;
  const turnId = live?.turnId ?? (message.turn_id || kept?.turnId);
  const projection = projectTurnActivity(useThinkingRows(live?.rows ?? settledRows ?? [], turnId), turnId);
  if (projection.phaseActivities.length === 0) return null;
  const currentState = live || !isTerminalProgressState(message.status ?? "") ? projection.semanticState : message.status;
  return <TurnActivityTimeline activities={projection.phaseActivities} currentState={currentState} live={Boolean(live)} turnId={turnId} />;
}

/**
 * The answer with its live parts: work without a phase timeline (blocks or a decision) above it
 * and the status line below it. Each folds away with its spacing when the turn settles.
 */
export function MessageLiveGroup({ live, kept, children, bubble = false }: {
  bubble?: boolean;
  live?: LiveTurnActivity;
  kept?: LiveTurnActivity;
  children: ReactNode;
}) {
  useAppLocale();
  const work = kept ? liveWork(kept) : null;
  return (
    <Stack gap="none" alignSelf={bubble ? "stretch" : undefined}>
      <Collapsible open={Boolean(live && work)} data-test-class="turn-live-work">
        <Stack gap="none">{work}<Space size="lg" /></Stack>
      </Collapsible>
      {/* The answer and its own parts keep the body's lg rhythm. */}
      <Stack gap="lg">{children}</Stack>
      <Collapsible open={Boolean(live)} data-test-class="turn-live-status">
        <Stack gap="none">
          <Space size="lg" />
          {/* A flex column keeps the inline status label the same height it has as a body row. */}
          <Stack gap="none" data-test-class="turn-live-status-line">{kept ? <TurnActivityStatus {...kept} chat={bubble} /> : null}</Stack>
        </Stack>
      </Collapsible>
    </Stack>
  );
}

function liveWork({ rows, turnId }: LiveTurnActivity): ReactNode {
  const projection = projectTurnActivity(rows, turnId);
  return projection.phaseActivities.length > 0 ? null : liveTurnWork(projection, turnId);
}
