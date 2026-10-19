import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { MessageRecord } from "@/app/types.ts";
import { OverflowActionMenu, Terminal } from "@/butler-ds";
import { useDeveloperMode } from "@/hooks/useDeveloperMode.ts";
import { openLogTrace } from "@/stores/logTraceStore.ts";
import { messageTraceTarget } from "./messageTrace";

/** Developer mode: the answer's overflow menu, with 로그 보기 for its trace. */
export function MessageTraceMenu({ message }: { message: MessageRecord }) {
  useAppLocale();
  const developerMode = useDeveloperMode();
  const trace = developerMode ? messageTraceTarget(message) : null;
  if (!trace) return null;
  return (
    <OverflowActionMenu label={appCopy.common.more} items={[{
      icon: <Terminal size="sm" />,
      label: appCopy.settings.logs.trace.viewLogs,
      onSelect: () => openLogTrace(trace),
    }]} />
  );
}
