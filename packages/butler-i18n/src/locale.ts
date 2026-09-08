import type { AppCopy, AppLocale, InterfaceTextReference } from "./copy-contract.ts";
import { koKrCopy } from "./locales/ko.ts";
import { enUsCopy } from "./locales/en.ts";

const appCopyByLocale: Record<AppLocale, AppCopy> = {
  "en-US": enUsCopy,
  "ko-KR": koKrCopy,
};
const defaultAppLocale: AppLocale = "en-US";

export function formatInterfaceText(reference: InterfaceTextReference, locale: AppLocale): string {
  const copy = getAppCopy(locale).guided;
  const parameters = reference.parameters ?? {};
  if (reference.key === "workerStatus") return copy.workerStatus[parameters.phase ?? "executing"] ?? copy.workerStatus.executing;
  const toolTitle = (name: string, target?: string): string => {
    if (name === "run_command" && target) return target;
    const title = copy.tools[name] ?? copy.tools.fallback;
    return target ? copy.fileTitle(title, target) : title;
  };
  if (reference.key === "toolTitle") return toolTitle(parameters.toolName ?? "fallback", parameters.target);
  if (reference.key === "toolsSummary") return copy.toolsSummary([...new Set((parameters.tools ?? []).map(tool => toolTitle(tool.name, tool.target)))].join(" · "));
  if (reference.key === "conceptionSummary") return copy.conceptionSummary(parameters.text ?? "");
  if (reference.key === "workInProgress") return copy.workInProgress(parameters.text ?? "");
  return copy[reference.key];
}

export function appLocaleFromLanguage(language?: string | null): AppLocale {
  const normalized = language?.trim().toLocaleLowerCase("en-US") ?? "";
  if (
    normalized === "ko" ||
    normalized === "ko-kr" ||
    normalized.includes("korean") ||
    normalized.includes("한국")
  ) {
    return "ko-KR";
  }
  return "en-US";
}

export function getAppCopy(locale: AppLocale = defaultAppLocale): AppCopy {
  return appCopyByLocale[locale];
}

export function getInterfaceProgressLabel(key: string | undefined, locale: AppLocale, parameters?: { attempt: number; maxAttempts: number }): string | undefined {
  const copy = getAppCopy(locale);
  if (key?.startsWith("operation:")) return copy.progress.operations[key.slice(10)] ?? copy.progress.fallback;
  if (key === "working") return copy.interfaceStatus.working;
  if (key === "accepted") return copy.conversation.work.pendingStateLabels.accepted;
  if (key === "generating") return copy.interfaceStatus.generating;
  if (key === "storageRecovery") return copy.progress.storageRecovery;
  if (key === "reconnecting") return parameters ? `${copy.progress.reconnecting} (${parameters.attempt}/${parameters.maxAttempts})` : copy.progress.reconnecting;
  if (key === "stopping") return copy.progress.stopping;
  return undefined;
}
