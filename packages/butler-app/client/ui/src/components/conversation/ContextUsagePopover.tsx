import { useMemo, useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { ContextDetailsView } from "@/app/types.ts";
import { Button, formatUsageTokens, Inline, ProgressMeter, Stack, Typo, UsageSummaryRows, Separator, UsageBars } from "@/butler-ds";
import { UsageReadout } from "../usage/UsageReadout";
import { usageReadout, usageSeries, usageTimeline } from "../usage/usageTimeline";
import { conversationUsageSummary } from "./conversationUsage";
import type { UsageAuthMode } from "./usageAuthMode";
import { useConversationUsage, type QuotaLoader, type UsageLoader } from "./useConversationUsage";

interface ContextUsagePopoverProps {
  context?: ContextDetailsView | null;
  mode: UsageAuthMode;
  sessionId: string | null;
  onDetails?: () => void;
  load?: UsageLoader;
  loadQuota?: QuotaLoader;
}

function contextRevision(context: ContextDetailsView): string {
  return context.updated_at ?? `${context.used_tokens}/${context.budget_tokens}`;
}

/** Context meter, this conversation's usage for the model's auth mode, and Details. */
export function ContextUsagePopover({ context, mode, sessionId, onDetails, load, loadQuota }: ContextUsagePopoverProps) {
  const locale = useAppLocale();
  const tracked = mode === "subscription" || mode === "api_key";
  const usage = useConversationUsage({
    sessionId: tracked ? sessionId : null,
    open: Boolean(context),
    revision: context ? contextRevision(context) : "",
    load,
    providerId: mode === "subscription" ? context?.provider_id ?? null : null,
    loadQuota,
  });
  const [selected, setSelected] = useState<number | null>(null);
  const timeline = useMemo(() => usageTimeline(usage.view, 24), [usage.view, locale]);
  if (!context) return null;
  const percent = Math.round(Math.max(0, Math.min(1, context.ratio)) * 100);
  const summary = conversationUsageSummary({ mode, context, ...usage });

  const bucket = selected === null ? undefined : timeline.buckets[selected];
  const copy = appCopy.composer.usage;
  return (
    <Stack gap="lg" data-test-class="context-usage" onKeyDownCapture={(event) => {
      if (event.key === "Escape" && selected !== null) { event.preventDefault(); event.stopPropagation(); setSelected(null); }
    }}>
      <Stack gap="xs">
        <ProgressMeter
          label={appCopy.interfacePanels.contextWindow}
          meta={appCopy.interfaceTemplates.contextMetric("full", percent)}
          value={percent}
        />
        <Typo.Caption numeric="tabular" tone="secondary">
          {formatUsageTokens(context.used_tokens, locale)} / {formatUsageTokens(context.budget_tokens, locale)}
          {context.auto_compact_at_tokens !== undefined ? ` · ${appCopy.interfaceTemplates.contextMetric("compact", formatUsageTokens(context.auto_compact_at_tokens, locale))}` : ""}
        </Typo.Caption>
      </Stack>
      {tracked ? <>
        <Separator />
        {!usage.view && usage.status === "failed" ? <Typo.Caption>{copy.unavailable}</Typo.Caption> :
          <UsageReadout view={usage.view} values={usageReadout(usage.view, bucket)} label={bucket?.label ?? copy.thisChat}
            unit={timeline.stepHours > 1 ? copy.bucketUnit(timeline.stepHours) : undefined}
            selected={Boolean(bucket)} showCost={mode === "api_key"}>
            <UsageBars {...timeline} series={usageSeries()} size="popover" selectedIndex={selected} onSelect={setSelected}
              state={!usage.view ? "loading" : "ready"} emptyLabel={copy.noUsage} loadingLabel={copy.loading}
              note={timeline.buckets.length === 1 ? copy.justStarted : undefined} ariaLabel={copy.chartLabel} />
          </UsageReadout>}
      </> : null}
      {mode === "subscription" && summary ? <><Separator /><Stack gap="sm">
        <Typo.Caption>{copy.accountLimits}</Typo.Caption><UsageSummaryRows {...summary} />
      </Stack></> : null}
      {onDetails ? (
        <Inline justify="end">
          <Button
            data-test-class="context-usage-details"
            size="sm"
            text={appCopy.composer.usage.details}
            type="button"
            variant="inline"
            onClick={onDetails}
          />
        </Inline>
      ) : null}
    </Stack>
  );
}
