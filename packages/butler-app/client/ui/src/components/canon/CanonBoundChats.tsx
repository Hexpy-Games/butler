import { Box, NavRow, Stack } from "@/butler-ds";
import { useButlerStore } from "@/app/store.ts";
import { projectSpace } from "@/app/space/projection.ts";
import type { EpicCard } from "@/app/canonApi.ts";
import { SpaceIdentity } from "../space/SpaceIdentity.tsx";
export function CanonBoundChats({ epic }: { epic: EpicCard }) {
  const navigation = useButlerStore(state => state.navigation);
  const active = useButlerStore(state => state.activeChatId);
  const rows = projectSpace(navigation);
  const bound = epic.session_ids.filter(id => id !== epic.home_session_id).flatMap(id => {
    const row = rows.get(`s:${id}`); return row ? [row] : [];
  });
  if (!bound.length) return null;
  return <Box paddingStart="lg"><Stack gap="none" data-test-class="canon-bound-chats">{bound.map(row => <NavRow key={row.node.entityId}
    label={row.title} icon={<SpaceIdentity row={row} />} active={active === row.node.entityId}
    onClick={() => void useButlerStore.getState().openSession(row.node.entityId)} /> )}</Stack></Box>;
}
