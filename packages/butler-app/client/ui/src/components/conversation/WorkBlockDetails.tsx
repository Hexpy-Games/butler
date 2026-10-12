import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { SessionView } from "@/app/types.ts";
import { Collapsible, ScrollArea } from "@/butler-ds";
import { SessionObserverBody } from "@/components/layout/SessionObserverBody.tsx";
import { useFollowLatest } from "./hooks/useFollowLatest.ts";
import { ObservedSessionContext } from "./observedSessionContext.ts";

/**
 * A work block's inline details: the observer dialog's list, bounded so a long
 * or live run never grows the conversation; it tails the newest row while live.
 */
export function WorkBlockDetails({ id, sessionId, title, view, open, live }: {
  id: string;
  sessionId: string;
  title: string;
  view?: SessionView;
  open: boolean;
  live: boolean;
}) {
  useAppLocale();
  const followLatest = useFollowLatest(open && live);
  return (
    <Collapsible
      aria-label={appCopy.conversation.work.detailsRegionLabel(title)}
      data-test-class="work-block-details"
      id={id}
      open={open}
      role="region"
    >
      <ScrollArea maxHeight="sm" scrollRef={followLatest} dataTestClass="work-block-details-scroll">
        <ObservedSessionContext.Provider value={sessionId}>
          <SessionObserverBody view={view} expandActivities />
        </ObservedSessionContext.Provider>
      </ScrollArea>
    </Collapsible>
  );
}
