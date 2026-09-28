import { useEffect } from "react";
import {
  agentNotice,
  readAgentRuntimeState,
  subscribeAgentRuntimeState,
  type AgentRuntimeState,
} from "@/app/agentRuntime.ts";
import { useButlerStore } from "@/app/store.ts";

/** Mirrors Electron main's Agent lifecycle state into `agentNotice`. */
export function useAgentRuntimeState(): void {
  useEffect(() => {
    let active = true;
    let observed = false;
    const apply = (state: AgentRuntimeState) => {
      if (!active || state === "unknown") return;
      const notice = agentNotice(state);
      if ((useButlerStore.getState().agentNotice ?? null) !== notice) {
        useButlerStore.setState({ agentNotice: notice });
      }
    };
    const unsubscribe = subscribeAgentRuntimeState((state) => {
      observed = true;
      apply(state);
    });
    void readAgentRuntimeState().then((state) => {
      if (!observed) apply(state);
    }, () => undefined);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
}
