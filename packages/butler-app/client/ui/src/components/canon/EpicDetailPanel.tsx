import { useEffect, useRef, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import type { EpicDetail as Epic, EpicInput, PlanCards, WorkTasks } from "@/app/canonApi.ts";
import { ADAPTIVE_MEDIA, ButtonContainer, Grid, IconButton, InspectorPanel, MessageSquare, Presence, X, useMediaMatch } from "@/butler-ds";
import { EpicDetail } from "./EpicDetail.tsx";
export function EpicDetailPanel({ epic, plans, tasks, busy, onWrite, onClose, onOpenSession, bottomInset = 0 }: {
  bottomInset?: number; epic: Epic | null; plans: PlanCards[]; tasks: WorkTasks | null; busy: boolean;
  onWrite: (input: EpicInput, message?: string) => Promise<boolean>; onClose: () => void; onOpenSession: (id: string) => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const compact = useMediaMatch(ADAPTIVE_MEDIA.compact);
  const [retained, setRetained] = useState(epic);
  useEffect(() => { if (epic) setRetained(epic); }, [epic]);
  const shown = epic ?? retained;
  useEffect(() => {
    if (!epic) return;
    panel.current?.scrollIntoView({ block: "nearest", behavior: "instant" });
    const previous = document.activeElement as HTMLElement | null;
    const heading = panel.current?.querySelector("h3");
    if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
    if (panel.current) revealAboveFooter(panel.current, bottomInset);
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [epic?.id, compact, bottomInset]);
  return <Presence present={Boolean(epic)} motion="fade">
    <Grid ref={panel} columns="1" role="complementary" gap="md" aria-label={appCopy.canon.epic} data-test-class="canon-detail-panel">
        <InspectorPanel title={appCopy.canon.epic} action={<ButtonContainer size="sm">
          <IconButton label={shown?.home_session_id ? appCopy.canon.openConversation : appCopy.canon.noConversation} disabled={!shown?.home_session_id}
            aria-label={appCopy.canon.openConversation}
            onClick={() => { if (shown?.home_session_id) onOpenSession(shown.home_session_id); }}><MessageSquare size="sm" /></IconButton>
          <IconButton label={appCopy.canon.close} onClick={onClose}><X size="sm" /></IconButton>
        </ButtonContainer>}>
          {shown && <EpicDetail key={shown.id} epic={shown} plans={plans} tasks={tasks} busy={busy} onWrite={onWrite} />}
        </InspectorPanel>
    </Grid>
  </Presence>;
}

/** The dashboard owns the composer's reserve; reveal the detail within its safe area. */
function revealAboveFooter(panel: HTMLElement, reserve: number) {
  if (!reserve) return;
  let scroller = panel.parentElement;
  while (scroller) {
    if (/auto|scroll/.test(getComputedStyle(scroller).overflowY)) {
      const top = panel.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      const hidden = panel.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom + reserve;
      scroller.scrollTop += Math.max(0, Math.min(top, hidden));
      return;
    }
    scroller = scroller.parentElement;
  }
}
