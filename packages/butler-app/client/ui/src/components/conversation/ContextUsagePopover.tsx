import { appCopy, getAppLocale, useAppLocale } from "@/app/copy.ts";
import type { ContextDetailsView } from "@/app/types.ts";
import { Button, formatUsageTokens, Inline, ProgressMeter, Stack, Typo, UsageSummaryRows } from "@/butler-ds";
import { conversationUsageSummary } from "./conversationUsage";
import type { UsageAuthMode } from "./usageAuthMode";
import { useConversationUsage, type UsageLoader } from "./useConversationUsage";

interface ContextUsagePopoverProps {
  context?: ContextDetailsView | null;
  mode: UsageAuthMode;
  sessionId: string | null;
  onDetails?: () => void;
  load?: UsageLoader;
}

function contextRevision(context: ContextDetailsView): string {
  return context.updated_at ?? `${context.used_tokens}/${context.budget_tokens}`;
}

/** Context meter, this conversation's usage for the model's auth mode, and Details. */
export function ContextUsagePopover({ context, mode, sessionId, onDetails, load }: ContextUsagePopoverProps) {
  useAppLocale();
  const tracked = mode === "subscription" || mode === "api_key";
  const usage = useConversationUsage({
    sessionId: tracked ? sessionId : null,
    open: Boolean(context),
    revision: context ? contextRevision(context) : "",
    load,
  });
  if (!context) return null;
  const percent = Math.round(Math.max(0, Math.min(1, context.ratio)) * 100);
  const locale = getAppLocale();
  const summary = conversationUsageSummary({ mode, context, ...usage });

  return (
    <Stack gap="lg" data-test-class="context-usage">
      <Stack gap="xs">
        <ProgressMeter
          label={appCopy.interfacePanels.contextWindow}
          meta={appCopy.interfaceTemplates.contextMetric("full", percent)}
          value={percent}
        />
        <Typo.Caption numeric="tabular" tone="secondary">
          {formatUsageTokens(context.used_tokens, locale)} / {formatUsageTokens(context.budget_tokens, locale)}
        </Typo.Caption>
      </Stack>
      {summary ? <UsageSummaryRows {...summary} /> : null}
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
