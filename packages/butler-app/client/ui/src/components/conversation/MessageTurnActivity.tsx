import { useState, type ReactNode } from "react";
import { projectTurnActivity } from "@/app/conversation-progress";
import { useAppLocale } from "@/app/copy";
import type { MessageRecord } from "@/app/types";
import { Collapsible, Space, Stack } from "@/butler-ds";
import { TurnActivityTimeline } from "./TurnActivityTimeline";
import { liveTurnWork, TurnActivityStatus, type LiveTurnActivity } from "./TurnActivityPanel";

const SETTLED_STATES = new Set(["delivered", "completed", "failed", "cancelled"]);

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
  const settledRows = message.turn_activity_rows?.length ? message.turn_activity_rows : kept?.rows;
  const turnId = live?.turnId ?? (message.turn_id || kept?.turnId);
  const projection = projectTurnActivity(live?.rows ?? settledRows ?? [], turnId);
  if (projection.phaseActivities.length === 0) return null;
  const currentState = live || !SETTLED_STATES.has(message.status ?? "") ? projection.semanticState : message.status;
  return <TurnActivityTimeline activities={projection.phaseActivities} currentState={currentState} live={Boolean(live)} turnId={turnId} />;
}

/**
 * The answer with its live parts: work without a phase timeline (blocks or a decision) above it
 * and the status line below it. Each folds away with its spacing when the turn settles.
 */
export function MessageLiveGroup({ live, kept, children }: {
  live?: LiveTurnActivity;
  kept?: LiveTurnActivity;
  children: ReactNode;
}) {
  useAppLocale();
  const work = kept ? liveWork(kept) : null;
  return (
    <Stack gap="none">
      <Collapsible open={Boolean(live && work)} data-test-class="turn-live-work">
        <Stack gap="none">{work}<Space size="lg" /></Stack>
      </Collapsible>
      {children}
      <Collapsible open={Boolean(live)} data-test-class="turn-live-status">
        <Stack gap="none">
          <Space size="lg" />
          {/* A flex column keeps the inline status label the same height it has as a body row. */}
          <Stack gap="none" data-test-class="turn-live-status-line">{kept ? <TurnActivityStatus {...kept} /> : null}</Stack>
        </Stack>
      </Collapsible>
    </Stack>
  );
}

function liveWork({ rows, turnId }: LiveTurnActivity): ReactNode {
  const projection = projectTurnActivity(rows, turnId);
  return projection.phaseActivities.length > 0 ? null : liveTurnWork(projection, turnId);
}
