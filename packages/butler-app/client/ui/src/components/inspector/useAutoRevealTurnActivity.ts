import { useEffect, useRef } from "react";
import { useButlerStore } from "@/app/store.ts";
import { phaseActivityRows } from "@/components/conversation/turnActivityRows";

export function useAutoRevealTurnActivity() {
  const activeTurnId = useButlerStore(
    (state) => state.sessionView?.active_turn?.id,
  );
  const progress = useButlerStore((state) => state.summary?.latest_progress);
  const openTurnActivity = useButlerStore((state) => state.openTurnActivity);
  const revealedTurnIds = useRef(new Set<string>());
  const progressTurnId = progress?.turn_id;
  const latestPhase = phaseActivityRows(
    progress?.safe_progress_rows ?? [],
  ).at(-1)?.phase;

  useEffect(() => {
    if (
      !progressTurnId ||
      activeTurnId !== progressTurnId ||
      !latestPhase ||
      !isManagedActivityPhase(latestPhase) ||
      revealedTurnIds.current.has(progressTurnId)
    ) {
      return;
    }

    revealedTurnIds.current.add(progressTurnId);
    openTurnActivity();
  }, [activeTurnId, latestPhase, openTurnActivity, progressTurnId]);
}

function isManagedActivityPhase(phase: string): boolean {
  return (
    phase === "conception_deliberation" ||
    phase === "contract_review" ||
    phase === "planning" ||
    phase === "planning_review" ||
    phase === "task_execution" ||
    phase === "task_review" ||
    phase === "consolidation" ||
    phase === "reporting" ||
    phase.startsWith("feedback_")
  );
}
