import type { AppLocale } from "./copy-contract.ts";

const labels: Record<AppLocale, Record<string, string>> = {
  "ko-KR": { none: "없음", minimal: "최소", low: "낮음", medium: "보통", high: "높음", xhigh: "매우 높음", max: "최대" },
  "en-US": { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Very high", max: "Max" },
};

/** Display only: provider IDs remain unchanged, including future levels. */
export function reasoningEffortLabel(value: string, locale: AppLocale): string {
  const copy = labels[locale];
  if (Object.hasOwn(copy, value)) return copy[value];
  if (!value) return copy.medium;
  return value.replace(/(^|[\s_-])(\p{L})/gu, (_match, separator: string, letter: string) =>
    `${separator}${letter.toLocaleUpperCase("en-US")}`);
}
