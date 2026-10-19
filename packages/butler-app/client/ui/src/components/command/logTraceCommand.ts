import { appCopy, getAppCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import type { CommandPaletteResult } from "@/app/types.ts";
import { openLogTrace, useLogTraceRoute } from "@/stores/logTraceStore.ts";

export const LOG_TRACE_COMMAND_ID = "open-logs";

/** Developer mode: 로그 열기, matched in the app language and in English. */
export function logTraceCommandResults(query: string, developerMode: boolean): CommandPaletteResult[] {
  if (!developerMode) return [];
  const copy = appCopy.settings.logs.trace;
  const needle = query.trim().toLocaleLowerCase();
  const names = [copy.openCommand, getAppCopy("en-US").settings.logs.trace.openCommand, appCopy.settings.sections.logs];
  if (needle && !names.some((name) => name.toLocaleLowerCase().includes(needle))) return [];
  return [{ id: LOG_TRACE_COMMAND_ID, kind: "settings", title: copy.openCommand, subtitle: copy.openCommandHint, route: "settings:logs" }];
}

/** The open conversation's latest turn as 메시지 추적; without one, the log list. */
export function openLatestLogTrace(): void {
  const { messages, activeChatId, openSettings, setCommandOpen } = useButlerStore.getState();
  const latest = [...messages].reverse().find((message) => message.turn_id && (message.chat_id ?? activeChatId) === activeChatId);
  if (latest?.turn_id) openLogTrace({ turnId: latest.turn_id });
  else {
    useLogTraceRoute.getState().close();
    openSettings("logs");
  }
  setCommandOpen(false);
}
