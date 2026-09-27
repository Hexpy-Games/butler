import { useEffect, useState } from "react";
import { apiErrorCode, subscribeLiveEvents } from "@/app/api.ts";
import { startFirstRunSetup } from "@/app/firstRunSetup.ts";
import { fetchSetupReadiness } from "@/app/setupConnection.ts";
import {
  combineReadiness,
  readinessFromEvent,
  type LocalPreparation,
  type SetupReadinessView,
} from "@/app/setupReadiness.ts";

/** How often agent readiness is re-read while it prepares (the live event may arrive sooner). */
export const READINESS_POLL_MS = 800;

export interface SetupReadinessController {
  readiness: SetupReadinessView;
  retry: () => void;
  repair: () => void;
}

/**
 * Agent preparation in the background of the first run: the desktop app's
 * local preparation first (`POST /setup/start`), then the agent's own
 * readiness (`GET /setup/readiness` and `setup.readiness_changed`).
 */
export function useSetupReadiness(): SetupReadinessController {
  const [local, setLocal] = useState<LocalPreparation>({ phase: "checking" });
  const [agent, setAgent] = useState<SetupReadinessView | "unsupported" | null>(null);
  const [attempt, setAttempt] = useState<{ mode: "check" | "repair" }>({ mode: "check" });

  useEffect(() => {
    let cancelled = false;
    setLocal({ phase: "checking" });
    setAgent(null);
    startFirstRunSetup(attempt.mode).then((status) => {
      if (cancelled || status.phase === "cancelled") return;
      setLocal(status.phase === "ready" ? { phase: "ready" } : { phase: "failed", error_code: status.error_code });
    }).catch((error: unknown) => {
      if (!cancelled) setLocal({ phase: "failed", error_code: apiErrorCode(error) });
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const settled = agent === "unsupported" || agent?.status === "ready" || agent?.status === "failed";
  useEffect(() => {
    if (local.phase !== "ready" || settled) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await fetchSetupReadiness();
        if (!cancelled) setAgent(next);
      } catch {
        // The agent is not answering yet; keep preparing.
      }
      if (!cancelled) timer = setTimeout(() => void poll(), READINESS_POLL_MS);
    };
    void poll();
    const unsubscribe = subscribeLiveEvents(0, (event) => {
      const next = readinessFromEvent(event);
      if (next && !cancelled) setAgent(next);
    }, () => undefined);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [local.phase, settled]);

  return {
    readiness: combineReadiness(local, agent),
    retry: () => setAttempt({ mode: "check" }),
    repair: () => setAttempt({ mode: "repair" }),
  };
}
