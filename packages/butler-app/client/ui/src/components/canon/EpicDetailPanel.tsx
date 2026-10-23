import { useEffect, useRef } from "react";
import { appCopy } from "@/app/copy.ts";
import type { EpicDetail as Epic, EpicInput, PlanCards, WorkTasks } from "@/app/canonApi.ts";
import { ADAPTIVE_MEDIA, ButtonContainer, Grid, IconButton, InspectorPanel, MessageSquare, Presence, X, useMediaMatch } from "@/butler-ds";
import { EpicDetail } from "./EpicDetail.tsx";
export function EpicDetailPanel({ epic, plans, tasks, busy, onWrite, onClose, onOpenSession, bottomInset = 0 }: {
  bottomInset?: number; epic: Epic | null; plans: PlanCards[]; tasks: WorkTasks | null; busy: boolean;
  onWrite: (input: EpicInput, message?: string) => Promise<boolean>; onClose: () => void; onOpenSession: (id: string) => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const compact = useMediaMatch(ADAPTIVE_MEDIA.compact);
  const retained = useRef(epic);
  if (epic) retained.current = epic;
  const shown = epic ?? retained.current;
  useEffect(() => {
    if (!epic) return;
    if (compact) panel.current?.scrollIntoView({ block: "start", behavior: "instant" });
    const previous = document.activeElement as HTMLElement | null;
    close.current?.focus({ preventScroll: true });
    if (panel.current) revealAboveFooter(panel.current, bottomInset);
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [epic?.id, compact, bottomInset]);
  return <Presence present={Boolean(epic)} motion="fade">
    <Grid ref={panel} columns="1" role="complementary" gap="md" aria-label={appCopy.canon.epic} data-test-class="canon-detail-panel">
        <InspectorPanel title={appCopy.canon.epic} action={<ButtonContainer size="sm">
          <IconButton label={shown?.home_session_id ? appCopy.canon.openConversation : appCopy.canon.noConversation} disabled={!shown?.home_session_id}
            aria-label={appCopy.canon.openConversation}
            onClick={() => { if (shown?.home_session_id) onOpenSession(shown.home_session_id); }}><MessageSquare size="sm" /></IconButton>
          <IconButton ref={close} label={appCopy.canon.close} onClick={onClose}><X size="sm" /></IconButton>
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
      scroller.scrollTop += Math.max(0, panel.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom + reserve);
      return;
    }
    scroller = scroller.parentElement;
  }
}
