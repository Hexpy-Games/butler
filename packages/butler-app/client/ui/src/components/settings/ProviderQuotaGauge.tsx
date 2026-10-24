import { useEffect, useState } from "react";
import { durationMinutes } from "../usage/usageHistoryModel";
import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import type { ProviderQuotaResultView } from "@/app/types.ts";
import { KeyValueRow, ProgressMeter, Stack, Tag, Tooltip, Typo, prefersReducedMotion } from "@/butler-ds";
import {
  formatQuotaTimestamp,
  formatRemaining,
  windowLabel,
} from "./providerQuotaPresentation";

type ProviderQuotaWindow = ProviderQuotaResultView["windows"][number];

function clampRemaining(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function remainingLabel(value: number | null): string {
  const formatted = formatRemaining(value);
  return value === null ? formatted : appCopy.interfaceTemplates.remaining(formatted);
}

function secondaryLabel(window: ProviderQuotaWindow): string | null {
  const details = [
    window.resetsAt
      ? appCopy.interfaceTemplates.resets(formatQuotaTimestamp(window.resetsAt))
      : null,
    window.expiresAt
      ? appCopy.interfaceTemplates.expires(formatQuotaTimestamp(window.expiresAt))
      : null,
  ].filter((detail): detail is string => detail !== null);
  return details.length > 0 ? details.join(" · ") : null;
}

function PageQuotaGauge({ window, stale }: { window: ProviderQuotaWindow; stale: boolean }) {
  const locale = useAppLocale(), copy = appCopy.composer.usage;
  const remaining = clampRemaining(window.remainingPercent);
  const [entered, setEntered] = useState(prefersReducedMotion);
  useEffect(() => {
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => setEntered(true)); });
    return () => cancelAnimationFrame(frame);
  }, []);
  const reset = window.resetsAt ?? window.expiresAt;
  const resetMs = reset ? Date.parse(reset) : NaN;
  const relative = Number.isFinite(resetMs) ? durationMinutes(Math.max(0, Math.ceil((resetMs - Date.now()) / 60000)), copy) : null;
  const resets = relative ? copy.resetsIn(relative) : null;
  const caption = remaining === 0 ? relative ? copy.limitResetsIn(relative) : copy.limitReached : resets;
  return <Stack gap="xs">
    {remaining === null ? <KeyValueRow label={windowLabel(window)} value={formatRemaining(null)} valueTextSize="caption" />
      : <ProgressMeter label={<Typo.Caption tone={stale ? "disabled" : "tertiary"}>{windowLabel(window)}</Typo.Caption>} value={entered ? remaining : 0}
        meta={<Typo.Caption tone={stale ? "disabled" : "tertiary"}>{formatRemaining(remaining)}</Typo.Caption>}
        ariaLabel={`${windowLabel(window)}: ${formatRemaining(remaining)}`}
        tone={remaining === 0 ? "danger" : remaining <= 20 ? "warning" : "default"} />}
    {caption ? <Tooltip label={reset && Number.isFinite(resetMs) ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(resetMs) : undefined}>
      <Typo.Caption tone={stale ? "disabled" : remaining === 0 ? "danger" : "secondary"}>{caption}</Typo.Caption>
    </Tooltip> : null}
  </Stack>;
}

export function ProviderQuotaGauge({ window, estimated = false, estimateTooltip = false, layout = "default", stale = false }: { window: ProviderQuotaWindow; estimated?: boolean; estimateTooltip?: boolean; layout?: "default" | "usage"; stale?: boolean }) {
  useAppLocale();
  const remaining = clampRemaining(window.remainingPercent);
  const text = windowLabel(window);
  const tag = <Tag>{appCopy.chatgptPlan.estimate}</Tag>;
  const label = estimated ? <Stack as="span" inline align="row" cross="center" gap="xs">{text}{estimateTooltip ? <Tooltip label={appCopy.chatgptPlan.estimateHint}>{tag}</Tooltip> : tag}</Stack> : text;
  const valueLabel = remainingLabel(remaining);
  const ariaLabel = `${text}: ${valueLabel}`;
  const secondary = secondaryLabel(window);

  if (layout === "usage") return <PageQuotaGauge window={window} stale={stale} />;
  return (
    <Stack gap="xs">
      {remaining === null ? (
        <Stack align="row" justify="between" cross="center" gap="sm">
          <Typo.Caption>{label}</Typo.Caption>
          <Typo.Caption>{valueLabel}</Typo.Caption>
        </Stack>
      ) : (
        <ProgressMeter
          label={label}
          value={remaining}
          meta={valueLabel}
          ariaLabel={ariaLabel}
        />
      )}
      {secondary ? (
        <Typo.Caption>{secondary}</Typo.Caption>
      ) : null}
    </Stack>
  );
}
