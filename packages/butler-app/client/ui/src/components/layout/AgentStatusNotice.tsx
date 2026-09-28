import { useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { agentNoticeLabel, startAgent, type AgentNotice } from "@/app/agentRuntime.ts";
import { notifyError } from "@/app/notifications.ts";
import { useButlerStore } from "@/app/store.ts";
import { Box, Button, CircleAlert, Notice, Spinner } from "@/butler-ds";

export function AgentStatusNotice({ notice }: { notice: AgentNotice }) {
  useAppLocale();
  const [starting, setStarting] = useState(false);
  const start = () => {
    setStarting(true);
    void startAgent()
      .then((state) => {
        if (state === "running") useButlerStore.setState({ agentNotice: null });
      })
      .catch((error: unknown) => notifyError(error, appCopy.feedback.agentStartFailed))
      .finally(() => setStarting(false));
  };
  const restarting = notice === "restarting";
  return (
    <Box paddingX="md" paddingY="sm" role="status" aria-live="polite"
      data-test-class="agent-status-notice">
      <Notice
        tone={restarting ? "info" : notice === "stopped" ? "warning" : "error"}
        icon={restarting ? <Spinner /> : <CircleAlert size="lg" />}
        message={agentNoticeLabel(notice)}
        action={restarting ? undefined : (
          <Button size="sm" variant="outline" disabled={starting} onClick={start}>
            {notice === "stopped" ? appCopy.feedback.agentStart : appCopy.feedback.retry}
          </Button>
        )}
      />
    </Box>
  );
}
