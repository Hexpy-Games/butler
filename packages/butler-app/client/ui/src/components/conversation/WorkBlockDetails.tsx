import type { SessionView } from "@/app/types.ts";
import { ScrollArea } from "@/butler-ds";
import { SessionObserverBody } from "@/components/layout/SessionObserverBody.tsx";
import { useFollowLatest } from "./hooks/useFollowLatest.ts";
import { ObservedSessionContext } from "./observedSessionContext.ts";

/**
 * A work block's inline details: the observer dialog's list, bounded so a long
 * or live run never grows the conversation; it tails the newest row while live.
 * WorkActivityDisclosure mounts it only while open.
 */
export function WorkBlockDetails({ sessionId, view, live }: {
  sessionId: string;
  view?: SessionView;
  live: boolean;
}) {
  const followLatest = useFollowLatest(live);
  return (
    <ScrollArea maxHeight="sm" scrollRef={followLatest} dataTestClass="work-block-details-scroll">
      <ObservedSessionContext.Provider value={sessionId}>
        <SessionObserverBody view={view} inline />
      </ObservedSessionContext.Provider>
    </ScrollArea>
  );
}
