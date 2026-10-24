import type { EpicCard } from "@/app/canonApi.ts";
import { useButlerStore } from "@/app/store.ts";
import { projectSpace } from "@/app/space/projection.ts";
import { spaceActivity } from "@/app/space/activity.ts";
import { Spinner } from "@/butler-ds";
import { CanonStatusGlyph } from "./CanonStatusGlyph.tsx";
export function CanonEpicStatus({ epic }: { epic: EpicCard }) {
  const running = useButlerStore(state => spaceActivity(epic.home_session_id
    ? projectSpace(state.navigation).get(`s:${epic.home_session_id}`)?.session : undefined) === "working");
  return running ? <Spinner size={16} /> : <CanonStatusGlyph status={epic.canon_status} />;
}
