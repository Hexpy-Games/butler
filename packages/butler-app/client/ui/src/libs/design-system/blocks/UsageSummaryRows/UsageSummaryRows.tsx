import type { ReactNode } from "react";
import { AnimatedNumber } from "../../components/AnimatedNumber";
import { SkeletonRows } from "../../components/Skeleton";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { KeyValueRow } from "../KeyValueRow";
import { ProgressMeter } from "../ProgressMeter";
import { formatUsageTokens, formatUsageUsd } from "./usageFormat";

export type UsageSummaryState = "ready" | "loading" | "unavailable";

export interface UsageQuotaWindow {
  id: string;
  /** Window name ("5-hour", "Weekly"). */
  label: string;
  /** 0-100; null when the provider reports no percent. */
  remainingPercent: number | null;
  /** One short line under the meter, e.g. the reset time. */
  caption?: ReactNode;
}

export interface UsageTokenRow {
  id: string;
  label: ReactNode;
  value: number;
}

export interface UsageCostRow {
  label: ReactNode;
  /** USD; null when unpriced (renders "—"). */
  usd: number | null;
  /** Priced from a rate table, not billed: adds `estimateLabel`. */
  estimated?: boolean;
}

export interface UsageSummaryRowsProps {
  state?: UsageSummaryState;
  quotaWindows?: UsageQuotaWindow[];
  tokens?: UsageTokenRow[];
  cost?: UsageCostRow;
  /** Meter meta from the rounded percent ("90%"), e.g. `(p) => \`${p} left\``. */
  remainingLabel?: (percent: string) => string;
  /** Marker after an estimated cost ("est."). */
  estimateLabel?: ReactNode;
  /** The single muted line of the unavailable state. */
  unavailableLabel: ReactNode;
  /** Accessible name of the loading skeleton. */
  loadingLabel?: string;
  /** Marks the data stale and shows this caption ("Updated 14:05"). */
  updatedLabel?: ReactNode;
  /** Locale for compact token counts; defaults to the document language. */
  locale?: string;
}

const DASH = "—";

function percentText(value: number): string {
  return `${Math.round(Math.max(0, Math.min(100, value)))}%`;
}

function QuotaWindow({ window, remainingLabel }: { window: UsageQuotaWindow; remainingLabel: (percent: string) => string }) {
  const percent = window.remainingPercent;
  const format = (value: number) => remainingLabel(percentText(value));
  return (
    <Stack gap="xs" data-slot="usage-quota-window">
      {percent === null || !Number.isFinite(percent) ? (
        <KeyValueRow label={window.label} value={DASH} valueTextSize="caption" />
      ) : (
        <ProgressMeter
          label={window.label}
          value={percent}
          meta={<AnimatedNumber value={percent} format={format} />}
          ariaLabel={`${window.label}: ${format(percent)}`}
        />
      )}
      {window.caption ? <Typo.Caption tone="tertiary">{window.caption}</Typo.Caption> : null}
    </Stack>
  );
}

function CostValue({ cost, estimateLabel }: { cost: UsageCostRow; estimateLabel?: ReactNode }) {
  if (cost.usd === null || !Number.isFinite(cost.usd)) return <>{DASH}</>;
  return (
    <>
      <AnimatedNumber value={cost.usd} format={formatUsageUsd} />
      {cost.estimated && estimateLabel ? (
        <>
          {" "}
          <Typo.Caption tone="tertiary" data-slot="usage-cost-estimate">{estimateLabel}</Typo.Caption>
        </>
      ) : null}
    </>
  );
}

/**
 * Provider usage for a popover or panel: quota windows as meters, token
 * counts and a USD cost as label/value rows, plus loading, unavailable and
 * stale states. Presenter only: the caller passes copy and numbers.
 */
export function UsageSummaryRows({
  state = "ready",
  quotaWindows = [],
  tokens = [],
  cost,
  remainingLabel = (percent) => percent,
  estimateLabel,
  unavailableLabel,
  loadingLabel,
  updatedLabel,
  locale,
}: UsageSummaryRowsProps) {
  if (state === "loading") {
    return (
      <Stack gap="sm" data-slot="usage-summary-rows" data-state="loading">
        <SkeletonRows rows={3} label={loadingLabel} />
      </Stack>
    );
  }
  if (state === "unavailable") {
    return (
      <Stack gap="sm" data-slot="usage-summary-rows" data-state="unavailable">
        <Typo.Caption tone="tertiary" data-slot="usage-unavailable">{unavailableLabel}</Typo.Caption>
      </Stack>
    );
  }
  const formatTokens = (value: number) => formatUsageTokens(value, locale);
  return (
    <Stack gap="md" data-slot="usage-summary-rows" data-state="ready" data-stale={updatedLabel ? "true" : undefined}>
      {quotaWindows.length > 0 ? (
        <Stack gap="md">
          {quotaWindows.map((window) => (
            <QuotaWindow key={window.id} window={window} remainingLabel={remainingLabel} />
          ))}
        </Stack>
      ) : null}
      {tokens.length > 0 || cost ? (
        <Stack gap="none">
          {tokens.map((row) => (
            <KeyValueRow
              key={row.id}
              label={row.label}
              value={<AnimatedNumber value={row.value} format={formatTokens} />}
              valueTextSize="caption"
            />
          ))}
          {cost ? (
            <KeyValueRow label={cost.label} value={<CostValue cost={cost} estimateLabel={estimateLabel} />} valueTextSize="caption" />
          ) : null}
        </Stack>
      ) : null}
      {updatedLabel ? <Typo.Caption tone="tertiary" data-slot="usage-updated">{updatedLabel}</Typo.Caption> : null}
    </Stack>
  );
}
