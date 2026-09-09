import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import type { SessionSummaryView } from "@/app/types.ts";
import { ProgressMeter, Stack } from "@/butler-ds";

function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return tokens.toLocaleString();
}

export function ContextUsagePopover({
  context,
}: {
  context?: SessionSummaryView["context_details"];
}) {
  useAppLocale();
  if (!context) return null;
  const percent = Math.round(Math.max(0, Math.min(1, context.ratio)) * 100);

  return (
    <Stack gap="sm">
      <strong>{appCopy.interfacePanels.contextWindow}: {appCopy.interfaceTemplates.contextMetric("full", percent)}</strong>
      <ProgressMeter label={appCopy.interfacePanels.contextWindow} value={percent} />
      <span>
        {formatTokenCount(context.used_tokens)} /{" "}
        {formatTokenCount(context.budget_tokens)}
      </span>
    </Stack>
  );
}
