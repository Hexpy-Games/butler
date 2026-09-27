import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import type { SessionSummaryView } from "@/app/types.ts";
import { ProgressMeter, Stack, Typo } from "@/butler-ds";

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
      <ProgressMeter
        label={appCopy.interfacePanels.contextWindow}
        meta={appCopy.interfaceTemplates.contextMetric("full", percent)}
        value={percent}
      />
      <Typo.Caption numeric="tabular" tone="secondary">
        {formatTokenCount(context.used_tokens)} / {formatTokenCount(context.budget_tokens)}
      </Typo.Caption>
    </Stack>
  );
}
