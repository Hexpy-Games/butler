import type { ProviderQuotaResultView } from "@/app/types.ts";
import { ProgressMeter, Stack, Typo } from "@/butler-ds";
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
  return formatted === "미확인" ? formatted : `${formatted} 남음`;
}

function secondaryLabel(window: ProviderQuotaWindow): string | null {
  const details = [
    window.resetsAt
      ? `재설정 ${formatQuotaTimestamp(window.resetsAt)}`
      : null,
    window.expiresAt
      ? `만료 ${formatQuotaTimestamp(window.expiresAt)}`
      : null,
  ].filter((detail): detail is string => detail !== null);
  return details.length > 0 ? details.join(" · ") : null;
}

export function ProviderQuotaGauge({ window }: { window: ProviderQuotaWindow }) {
  const remaining = clampRemaining(window.remainingPercent);
  const label = windowLabel(window);
  const valueLabel = remainingLabel(remaining);
  const ariaLabel = `${label}: ${valueLabel}`;
  const secondary = secondaryLabel(window);

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
