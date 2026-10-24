import type { EpicCard } from "@/app/canonApi.ts";
import { useButlerStore } from "@/app/store.ts";
import { projectSpace } from "@/app/space/projection.ts";
import { spaceActivity } from "@/app/space/activity.ts";
import { Spinner, Stack } from "@/butler-ds";
import { CanonStatusGlyph } from "./CanonStatusGlyph.tsx";

function useEpicWorking(epic: EpicCard): boolean {
  return useButlerStore(state => spaceActivity(epic.home_session_id
    ? projectSpace(state.navigation).get(`s:${epic.home_session_id}`)?.session : undefined) === "working");
}

export function CanonEpicStatus({ epic }: { epic: EpicCard }) {
  return useEpicWorking(epic) ? <Spinner size={16} /> : <CanonStatusGlyph status={epic.canon_status} />;
}

/** The Spinner while the epic's conversation is working; nothing otherwise (the board lane shows the status). */
export function CanonEpicActivity({ epic }: { epic: EpicCard }) {
  return useEpicWorking(epic) ? <Stack shrink={false}><Spinner size={16} /></Stack> : null;
}
