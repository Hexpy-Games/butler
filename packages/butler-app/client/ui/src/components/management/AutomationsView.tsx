import { useEffect, useMemo, useState } from "react";
import { allSessionsFromNavigation } from "@/app/utils.ts";
import { useButlerStore } from "@/app/store.ts";
import type { NavigationView, StatusPill } from "@/app/types.ts";
import { useAutomationsList } from "./hooks/useAutomationsList";
import { AutomationsList } from "./AutomationsList";
import { AutomationDetail } from "./AutomationDetail";

export function AutomationsView({
  navigation: navigationProp,
  activeAutomationId,
  onOpenAutomation,
  onNewAutomation,
  onBack,
  onStatus,
  onRefreshNavigation,
}: {
  navigation?: NavigationView;
  activeAutomationId?: string | null;
  onOpenAutomation?: (automationId: string) => void;
  onNewAutomation?: () => void;
  onBack?: () => void;
  onStatus?: (status: StatusPill) => void;
  onRefreshNavigation?: () => Promise<void>;
} = {}) {
  const storeNavigation = useButlerStore((state) => state.navigation);
  const view = useButlerStore((state) => state.view);
  const setView = useButlerStore((state) => state.setView);
  const setStatus = useButlerStore((state) => state.setStatus);
  const refreshNavigation = useButlerStore((state) => state.refreshNavigation);
  const navigation = navigationProp ?? storeNavigation;
  const resolvedAutomationId =
    activeAutomationId ??
    (view.kind === "automation-detail" ? view.automationId : null);
  const [selectedId, setSelectedId] = useState(resolvedAutomationId);
  const reportStatus = onStatus ?? setStatus;
  const { automations, refresh: refreshAutomations } =
    useAutomationsList(reportStatus);

  useEffect(() => {
    setSelectedId(resolvedAutomationId);
  }, [resolvedAutomationId]);

  async function refresh() {
    await refreshAutomations();
    await (onRefreshNavigation ?? refreshNavigation)();
  }

  const targetSessions = useMemo(
    () => allSessionsFromNavigation(navigation),
    [navigation],
  );

  const openAutomation =
    onOpenAutomation ??
    ((automationId) => setView({ kind: "automation-detail", automationId }));
  const newAutomation =
    onNewAutomation ??
    (() => setView({ kind: "automation-detail", automationId: "new" }));
  const back = onBack ?? (() => setView({ kind: "automations" }));

  const handleSelectAutomation = (automationId: string) => {
    setSelectedId(automationId);
    openAutomation(automationId);
  };

  if (!selectedId) {
    return (
      <AutomationsList
        automations={automations}
        selectedId={selectedId}
        onSelectAutomation={handleSelectAutomation}
        onNewAutomation={newAutomation}
      />
    );
  }

  return (
    <AutomationDetail
      automationId={selectedId}
      targetSessions={targetSessions}
      onBack={back}
      onSaved={refresh}
      onStatus={reportStatus}
    />
  );
}
