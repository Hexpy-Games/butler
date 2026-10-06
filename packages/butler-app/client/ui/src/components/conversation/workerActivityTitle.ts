import { appCopy } from "@/app/copy.ts";

export function workerActivityTitle(
  currentActivity: string,
  taskTitle: string,
): string {
  const current = currentActivity.trim();
  if (isUsefulWorkerActivityTitle(current)) return current;
  const title = taskTitle.trim();
  return isUsefulWorkerActivityTitle(title)
    ? title
    : appCopy.interfaceDetails.workerActivity;
}

function isUsefulWorkerActivityTitle(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  const genericLabels = [
    appCopy.interfaceStatus.progress,
    appCopy.guided.tools.fallback,
    appCopy.interfaceDetails.workerActivity,
    "작업 중",
    "도구 사용",
    "도구 사용 내역",
    "tool use",
    "tool usage",
    "use tool",
    "working",
    "native child work",
  ];
  return Boolean(normalized) &&
    !genericLabels.some((label) => normalized === label.trim().toLowerCase()) &&
    !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/u.test(normalized);
}
