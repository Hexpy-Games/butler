import { getAppCopy, getAppLocale } from "@/app/copy.ts";

/** Legacy gateways send localized status text without an interface reference. */
export function localizeWorkerActivity(value: string): string {
  const trimmed = value.trim();
  for (const locale of ["en-US", "ko-KR"] as const) {
    const statuses = getAppCopy(locale).guided.workerStatus;
    const phase = Object.keys(statuses).find((key) => statuses[key] === trimmed);
    if (phase) return getAppCopy(getAppLocale()).guided.workerStatus[phase] ?? value;
  }
  return value;
}
