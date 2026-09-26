import { useButlerStore } from "@/app/store.ts";
import { useWorkStatus } from "./hooks/useWorkStatus";
import { SpaceWorkStatusList } from "./SpaceWorkStatusList";

/** Work status in the sidebar Running tab, after the running conversations. */
export function SpaceWorkStatus() {
  const openSession = useButlerStore((state) => state.openSession);
  const { view } = useWorkStatus();
  return <SpaceWorkStatusList view={view} onOpenSession={openSession} />;
}
