import { useState } from "react";
import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { Box, Button, CircleAlert, Notice } from "@/butler-ds";
import { setComputerConnection } from "@/app/computerEvents";
import { notifyError } from "@/app/notifications";
import { sessionFromNavigation } from "@/app/utils";
import { reconnectComputer } from "../settings/computersApi";
import { useActiveComputerUnreachable } from "../conversation/hooks/useActiveComputerUnreachable";
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

export function ConversationConnectionNotice() {
  useAppLocale();
  const [pending, setPending] = useState(false);
  const name = useActiveComputerUnreachable();
  const agentNotice = useButlerStore((state) => state.agentNotice);
  const computerId = useButlerStore((state) => sessionFromNavigation(state.navigation, state.activeChatId)?.computer_id);
  if (agentNotice || !name || !computerId) return <LiveConnectionNotice />;
  return (
    <Box paddingX="md" paddingY="sm" role="status" aria-live="polite">
      <Notice tone="error" icon={<CircleAlert size="lg" />} message={appCopy.computers.unreachable(name)}
        action={<Button size="sm" variant="outline" disabled={pending} onClick={() => {
          setPending(true);
          void reconnectComputer(computerId)
            .then(({ state }) => setComputerConnection(computerId, state))
            .catch((error: unknown) => notifyError(error, appCopy.interfaceFeedback.requestFailed))
            .finally(() => setPending(false));
        }}>{appCopy.feedback.reconnect}</Button>} />
    </Box>
  );
}
