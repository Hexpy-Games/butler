import { getAppCopy, appLocaleFromLanguage, getInterfaceProgressLabel, formatInterfaceText, type InterfaceContentReferences, type AppCopy, type AppLocale } from "../../../../../butler-i18n/src/index.ts";
import type { ProgressRow } from "./types.ts";
import { useSyncExternalStore } from "react";

export { getAppCopy, appLocaleFromLanguage };
export type { AppCopy, AppLocale };

let activeAppLocale: AppLocale = "en-US";
const localeListeners = new Set<() => void>();

function subscribeAppLocale(listener: () => void): () => void {
  localeListeners.add(listener);
  return () => localeListeners.delete(listener);
}

export function useAppLocale(): AppLocale {
  return useSyncExternalStore(subscribeAppLocale, getAppLocale, getAppLocale);
}

export function getAppLocale(): AppLocale {
  return activeAppLocale;
}

export function interfaceText(reference: import("../../../../../butler-i18n/src/index.ts").InterfaceTextReference | undefined, fallback: string): string {
  return reference ? formatInterfaceText(reference, activeAppLocale) : fallback;
}

export function interfaceProgressLabel(row: { safe_label: string; work_decision_summary?: string; interface_content?: InterfaceContentReferences; interface_label_key?: string; interface_label_parameters?: { attempt: number; maxAttempts: number } }): string {
  const reference = row.interface_content?.summary ?? (!row.work_decision_summary ? row.interface_content?.title : undefined);
  if (reference) return formatInterfaceText(reference, activeAppLocale);
  return getInterfaceProgressLabel(row.interface_label_key, activeAppLocale, row.interface_label_parameters) ?? row.safe_label;
}

export function localizeProgressRow(row: ProgressRow): ProgressRow {
  const content = row.interface_content;
  if (!content && !row.interface_label_key) return row;
  return { ...row, safe_label: interfaceProgressLabel(row),
    ...(content?.title ? { work_decision_title: formatInterfaceText(content.title, activeAppLocale), work_block_label: formatInterfaceText(content.title, activeAppLocale) } : {}),
    ...(content?.summary ? { work_decision_summary: formatInterfaceText(content.summary, activeAppLocale) } : {}),
    ...(content?.nextStep ? { work_decision_next_step: formatInterfaceText(content.nextStep, activeAppLocale) } : {}),
  };
}

export function interfaceArgumentLabel(kind: string | undefined, label: string): string {
  return kind?.startsWith("argument_") ? getAppCopy(activeAppLocale).guided.argumentLabels[kind.slice(9)] ?? label : label;
}

export function setAppCopyLanguage(language?: string | null): void {
  const next = appLocaleFromLanguage(language);
  if (next === activeAppLocale) return;
  activeAppLocale = next;
  for (const listener of localeListeners) listener();
}

export const appCopy = new Proxy({} as AppCopy, {
  get(_target, property: keyof AppCopy) {
    return getAppCopy(activeAppLocale)[property];
  },
});
