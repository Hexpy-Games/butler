import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { AgentStatusNotice } from "./AgentStatusNotice.tsx";

export function LiveConnectionNotice() {
  useAppLocale();
  const disconnected = useButlerStore((state) => state.liveConnectionLost);
  const agentNotice = useButlerStore((state) => state.agentNotice);
  if (agentNotice) return <AgentStatusNotice notice={agentNotice} />;
  if (!disconnected) return null;
  return (
    <div className="sr-only" role="status" aria-live="polite" data-test-class="live-connection-notice">
      {appCopy.feedback.reconnecting}
    </div>
  );
}
