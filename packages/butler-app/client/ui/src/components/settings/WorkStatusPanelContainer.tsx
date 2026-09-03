import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { SettingsSection } from "./SettingsSection";
import { WorkStatusPanel } from "./WorkStatusPanel";
import { useWorkStatus } from "./hooks/useWorkStatus";

export function WorkStatusPanelContainer() {
  const openSession = useButlerStore((state) => state.openSession);
  const { view, unavailable } = useWorkStatus();
  const copy = appCopy.settings.workStatus;
  return (
    <SettingsSection title={copy.title} description={copy.description}>
      <WorkStatusPanel
        view={view}
        unavailable={unavailable}
        onOpenSession={openSession}
      />
    </SettingsSection>
  );
}
