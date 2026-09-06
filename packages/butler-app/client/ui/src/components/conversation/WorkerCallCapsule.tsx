import { useButlerStore } from "@/app/store.ts";
import { workerActivityDisplayName } from "@/app/utils.ts";
import { PillButton, Stack } from "@/butler-ds";
import { stewardPlanProgress } from "./stewardProgressPresentation.ts";

/** The invocation owns placement; SessionView owns the live child state. */
export function WorkerCallCapsule({ turnId, callId }: { turnId: string; callId: string }) {
  const worker = useButlerStore((state) => {
    const sessionId = state.observerSessionId ?? state.activeChatId;
    return state.sessionViews[sessionId]?.workers.find((item) =>
      item.parent_turn_id === turnId && item.source_tool_call_id === callId,
    );
  });
  const open = useButlerStore((state) => state.openSessionObserver);
  if (!worker) return null;
  const progress = stewardPlanProgress(worker);
  const label = [workerActivityDisplayName(worker), worker.status_line, progress].filter(Boolean).join(" · ");
  return (
    <Stack cross="start" gap="xs" data-test-class="worker-call-capsule" data-worker-id={worker.worker_id}>
      <PillButton
        surface="glass"
        aria-label={`${label}, 활동 보기`}
        title={worker.current_activity_title ?? worker.objective}
        onClick={() => open(worker.session_id ?? worker.worker_id)}
      >
        {label}
      </PillButton>
    </Stack>
  );
}
