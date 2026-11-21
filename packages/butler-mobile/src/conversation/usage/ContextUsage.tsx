import { useMemo, useState } from "react";
import { View } from "react-native";
import { getAppCopy } from "../../../../butler-i18n/src/index.ts";
import type { ContextDetails, ModelSummary } from "../../../../butler-protocol/src/index.ts";
import { compactTokens } from "../../../../butler-app/client/ui/src/components/usage/compactTokens.ts";
import { Meter, Text, useTokens } from "@/ds";
import { useAppLocale } from "@/i18n";
import { contextModel, quotaSummary, usageAuthMode, usageTimeline } from "./usageView";
import { useConversationUsage } from "./useConversationUsage";
import { UsageReadout } from "./UsageReadout";
import { PlanUsage } from "./PlanUsage";

export function ContextUsage({ open, context, sessionId, model, models = [] }: {
  open: boolean; context: ContextDetails; sessionId?: string; model?: ModelSummary; models?: ModelSummary[];
}) {
  const t = useTokens();
  const locale = useAppLocale();
  const copy = getAppCopy(locale);
  const mode = usageAuthMode(contextModel(models, context, model ?? null), context);
  const tracked = mode === "subscription" || mode === "api_key";
  const usage = useConversationUsage({ open, context, sessionId: tracked ? sessionId ?? null : null,
    providerId: mode === "subscription" ? context.provider_id ?? null : null });
  const timeline = useMemo(() => usageTimeline(usage.view, 24, copy, locale), [usage.view, copy, locale]);
  const [selected, setSelected] = useState<number | null>(null);
  const percent = Math.round(Math.max(0, Math.min(1, context.ratio)) * 100);
  const summary = quotaSummary(mode, context, usage.view, usage.quota, usage.status, copy, locale);
  const divider = <View style={{ height: t.length("--border-hairline"), backgroundColor: t.color("--line") }} />;
  return <View style={{ gap: t.length("--space-4") }}>
    <View style={{ gap: t.length("--space-1") }}>
      <Meter label={copy.interfacePanels.contextWindow} meta={copy.interfaceTemplates.contextMetric("full", percent)} value={percent} />
      <Text variant="caption" numeric="tabular" tone="secondary">
        {`${compactTokens(context.used_tokens, locale)} / ${compactTokens(context.budget_tokens, locale)}`}
        {context.auto_compact_at_tokens !== undefined ? ` · ${copy.interfaceTemplates.contextMetric("compact", compactTokens(context.auto_compact_at_tokens, locale))}` : ""}
      </Text>
    </View>
    {tracked ? <>{divider}<UsageReadout view={usage.view} status={usage.status} mode={mode} timeline={timeline}
      selected={selected} onSelect={setSelected} /></> : null}
    {mode === "subscription" && summary ? <>{divider}<PlanUsage summary={summary} /></> : null}
  </View>;
}
