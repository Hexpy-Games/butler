import { useEffect, useMemo } from "react";
import type { SessionOption, StatusPill } from "@/app/types.ts";
import { useAutomationStore } from "@/stores/automationStore";
import { AutomationActions } from "./AutomationActions";
import { AutomationForm } from "./AutomationForm";
import { AutomationRuns } from "./AutomationRuns";
import { ManagementPage } from "@/butler-ds";

interface AutomationDetailProps {
  automationId: string;
  targetSessions: SessionOption[];
  onBack: () => void;
  onSaved: () => Promise<void>;
  onStatus: (status: StatusPill) => void;
}

export function AutomationDetail({
  automationId,
  targetSessions,
  onBack,
  onSaved,
  onStatus,
}: AutomationDetailProps) {
  const sessionOptions = useMemo(
    () =>
      targetSessions.length > 0
        ? targetSessions
        : [{ id: "general", label: "General chat" }],
    [targetSessions],
  );

  const initialize = useAutomationStore((state) => state.initialize);
  const save = useAutomationStore((state) => state.save);
  const mutate = useAutomationStore((state) => state.mutate);
  const remove = useAutomationStore((state) => state.remove);
  const runs = useAutomationStore((state) => state.runs);

  useEffect(() => {
    initialize(automationId, sessionOptions, onStatus);
  }, [automationId, initialize, sessionOptions, onStatus]);

  return (
    <ManagementPage
      as="form"
      dataTestClass="automation-detail-view"
      onSubmit={(event) => save(event, onSaved, onStatus)}
    >
      <AutomationActions
        onBack={onBack}
        onRun={() => mutate("run", onSaved, onStatus)}
        onPause={() => mutate("pause", onSaved, onStatus)}
        onResume={() => mutate("resume", onSaved, onStatus)}
        onDelete={() => remove(onSaved, onBack, onStatus)}
      />
      <AutomationForm>
        <AutomationRuns runs={runs} />
      </AutomationForm>
    </ManagementPage>
  );
}
