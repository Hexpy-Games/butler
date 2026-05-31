import { AutomationRunList } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { relativeAge } from "@/app/utils.ts";
import type { AutomationRunSummary } from "@/app/types.ts";

interface AutomationRunsProps {
  runs: AutomationRunSummary[];
}

export function AutomationRuns({ runs }: AutomationRunsProps) {
  return (
    <AutomationRunList
      title={appCopy.automations.fields.runs}
      emptyLabel={appCopy.automations.runs.empty}
      runs={runs.slice(0, 6).map((run) => ({
        id: run.id,
        title: automationRunLabel(run.state),
        meta: relativeAge(run.started_at),
      }))}
    />
  );
}

function automationRunLabel(state: string): string {
  const copy = appCopy.automations.runs;
  if (state === "queued") return copy.queued;
  if (state === "succeeded") return copy.succeeded;
  if (state === "failed") return copy.failed;
  if (state === "running") return copy.running;
  if (state === "skipped_target_unavailable")
    return copy.skippedTargetUnavailable;
  if (state === "cancelled") return copy.cancelled;
  return copy.notRun;
}
