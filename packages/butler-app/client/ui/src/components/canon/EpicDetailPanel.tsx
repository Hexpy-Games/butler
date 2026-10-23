import { useEffect, useRef } from "react";
import { appCopy } from "@/app/copy.ts";
import type { EpicDetail as Epic, EpicInput, PlanCards, WorkTasks } from "@/app/canonApi.ts";
import { Box, ButtonContainer, Grid, IconButton, InspectorPanel, MessageSquare, PanelHeader, Presence, Stack, X } from "@/butler-ds";
import { EpicDetail } from "./EpicDetail.tsx";
export function EpicDetailPanel({ epic, plans, tasks, busy, onWrite, onClose, onOpenSession }: {
  epic: Epic | null; plans: PlanCards[]; tasks: WorkTasks | null; busy: boolean;
  onWrite: (input: EpicInput, message?: string) => Promise<boolean>; onClose: () => void; onOpenSession: (id: string) => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const retained = useRef(epic);
  if (epic) retained.current = epic;
  const shown = epic ?? retained.current;
  useEffect(() => { if (epic) panel.current?.focus({ preventScroll: true }); }, [epic?.id]);
  return <Presence present={Boolean(epic)} motion="fade">
    <Grid ref={panel} columns="1" tabIndex={-1} role="complementary" gap="md" aria-label={appCopy.canon.epic} data-test-class="canon-detail-panel">
      <Box surface="base" border="hairline" radius="panel" padding="md">
        <Stack gap="md">
        <PanelHeader title={appCopy.canon.epic} actions={<ButtonContainer size="sm">
          <IconButton label={shown?.home_session_id ? appCopy.canon.openConversation : appCopy.canon.noConversation} disabled={!shown?.home_session_id}
            aria-label={appCopy.canon.openConversation}
            onClick={() => { if (shown?.home_session_id) onOpenSession(shown.home_session_id); }}><MessageSquare size="sm" /></IconButton>
          <IconButton label={appCopy.canon.close} onClick={onClose}><X size="sm" /></IconButton>
        </ButtonContainer>} />
        <InspectorPanel title={null}>
          {shown && <EpicDetail key={shown.id} epic={shown} plans={plans} tasks={tasks} busy={busy} onWrite={onWrite} />}
        </InspectorPanel>
        </Stack>
      </Box>
    </Grid>
  </Presence>;
}
