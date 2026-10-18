import { useAppLocale } from "@/app/copy.ts";
import { AutomationRunList, Button } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { relativeAge } from "@/app/utils.ts";
import type { AutomationRunSummary } from "@/app/types.ts";
import { useDeveloperMode } from "@/hooks/useDeveloperMode.ts";
import { openLogTrace } from "@/stores/logTraceStore.ts";

interface AutomationRunsProps {
  runs: AutomationRunSummary[];
}

export function AutomationRuns({ runs }: AutomationRunsProps) {
  useAppLocale();
  const developerMode = useDeveloperMode();
  return (
    <AutomationRunList
      title={appCopy.automations.fields.runs}
      emptyLabel={appCopy.automations.runs.empty}
      runs={runs.slice(0, 6).map((run) => ({
        id: run.id,
        title: automationRunLabel(run),
        meta: relativeAge(run.started_at),
        // Developer mode: the run's trace, once it started a turn.
        description: developerMode && run.turn_id ? <RunLogsButton turnId={run.turn_id} /> : undefined,
      }))}
    />
  );
}

function RunLogsButton({ turnId }: { turnId: string }) {
  return (
    <Button type="button" size="sm" variant="ghost" data-test-class="automation-run-logs"
      onClick={() => openLogTrace({ turnId })}>
      {appCopy.settings.logs.trace.viewLogs}
    </Button>
  );
}

function automationRunLabel({ state, safe_error_code }: AutomationRunSummary): string {
  const copy = appCopy.automations.runs;
  if (safe_error_code === "schedule_permission_required") return copy.needsPermission;
  if (state === "queued") return copy.queued;
  if (state === "succeeded") return copy.succeeded;
  if (state === "failed") return copy.failed;
  if (state === "running") return copy.running;
  if (state === "skipped_target_unavailable")
    return copy.skippedTargetUnavailable;
  if (state === "cancelled") return copy.cancelled;
  return copy.notRun;
}
