import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { workerActivityDisplayName, workerActivityStatusLine } from "@/app/utils.ts";
import { Button, Stack } from "@/butler-ds";
import { stewardPlanProgress } from "./stewardProgressPresentation.ts";

/** The invocation owns placement; SessionView owns the live child state. */
export function WorkerCallCapsule({ turnId, callId }: { turnId: string; callId: string }) {
  useAppLocale();
  const worker = useButlerStore((state) => {
    const sessionId = state.observerSessionId ?? state.activeChatId;
    return state.sessionViews[sessionId]?.workers.find((item) =>
      item.parent_turn_id === turnId && item.source_tool_call_id === callId,
    );
  });
  const open = useButlerStore((state) => state.openSessionObserver);
  if (!worker) return null;
  const progress = stewardPlanProgress(worker);
  const activity = workerActivityStatusLine(worker);
  const label = [workerActivityDisplayName(worker), progress, activity].filter(Boolean).join(" · ");
  return (
    <Stack cross="start" gap="xs" data-test-class="worker-call-capsule" data-worker-id={worker.worker_id}>
      <Button
        variant="outline"
        shape="pill"
        aria-label={appCopy.interfaceTemplates.viewActivity(label)}
        title={activity || worker.objective}
        onClick={() => open(worker.session_id ?? worker.worker_id)}
        text={label}
      />
    </Stack>
  );
}
