import { appCopy } from "@/app/copy.ts";
import type { SystemEventSummary } from "@/app/types.ts";
import { Stack, SurfacePanel, Typo } from "@/butler-ds";

export function SystemEventCard({ event }: { event: SystemEventSummary }) {
  const timeLabel = event.occurred_at ? formatTimestamp(event.occurred_at) : "";
  const eventLabels = appCopy.settings.systemEventLabels;
  const modelLabel = event.model_ref
    ? ` · ${event.model_ref}${
        event.uses_butler_model
          ? ` · ${appCopy.settings.options.consolidationModelDefault}`
          : ""
      }`
    : "";
  const metrics = event.metrics
    .filter(
      (metric) =>
        metric.label !== "raw_text_included" && metric.label !== "job_id",
    )
    .slice(0, 8);

  return (
    <SurfacePanel elevation="none">
      <Stack gap="sm">
        <Stack align="row" cross="center" justify="between" gap="md" wrap>
          <Stack gap="xs">
            <Typo.Body as="div">
              {systemEventTitle(event, eventLabels.titles)}
            </Typo.Body>
            <Typo.Caption>
              {systemEventStatus(event.status, eventLabels.statuses)}
              {timeLabel ? ` · ${timeLabel}` : ""}
              {modelLabel}
            </Typo.Caption>
          </Stack>
          {event.duration_ms !== undefined && (
            <Typo.Caption>{formatDuration(event.duration_ms)}</Typo.Caption>
          )}
        </Stack>
        {metrics.length > 0 && (
          <Typo.Caption>{formatMetrics(metrics, eventLabels)}</Typo.Caption>
        )}
      </Stack>
    </SurfacePanel>
  );
}

function systemEventTitle(
  event: SystemEventSummary,
  labels: typeof appCopy.settings.systemEventLabels.titles,
): string {
  if (event.kind === "profile_consolidation") return labels.profile;
  if (event.kind === "consolidation_run") return labels.consolidation;
  const jobId = event.metrics.find((metric) => metric.label === "job_id")?.value;
  if (jobId === "session-sync") return labels.sessionSync;
  if (jobId === "context-maintenance") return labels.contextMaintenance;
  if (jobId === "consolidation-cycle") return labels.consolidationCycle;
  return event.title;
}

function systemEventStatus(
  status: string,
  labels: typeof appCopy.settings.systemEventLabels.statuses,
): string {
  if (status === "ok") return labels.ok;
  if (status === "completed") return labels.completed;
  if (status === "failed") return labels.failed;
  if (status === "running") return labels.running;
  if (status === "not_run") return labels.notRun;
  return labels.unknown;
}

function formatMetrics(
  metrics: SystemEventSummary["metrics"],
  labels: typeof appCopy.settings.systemEventLabels,
): string {
  return metrics
    .map((metric) => {
      const label = labels.metrics[metric.label] ?? metric.label;
      return `${label}: ${systemEventMetricValue(metric.value, labels.values)}`;
    })
    .join(" · ");
}

function systemEventMetricValue(
  value: SystemEventSummary["metrics"][number]["value"],
  labels: typeof appCopy.settings.systemEventLabels.values,
): string {
  if (typeof value === "boolean") return value ? labels.yes : labels.no;
  if (value === "deep") return labels.deep;
  if (value === "basic") return labels.basic;
  if (value === "off") return labels.off;
  return String(value);
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`;
  const seconds = Math.round(durationMs / 100) / 10;
  return `${seconds}s`;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}
