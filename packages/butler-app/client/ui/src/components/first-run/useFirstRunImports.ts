import { useRef } from "react";
import { useAgentImport } from "../imports/useAgentImport";
import { useAgentPicks } from "./useAgentPicks";

/** First run imports from other AI tools only; browsers are imported from Settings. */
export function useFirstRunImports(enabled: boolean) {
  const started = useRef(false);
  if (enabled) started.current = true;
  const agentImport = useAgentImport(started.current);
  const agentPicks = useAgentPicks(agentImport);
  const agents = agentImport.result && !agentImport.undone ? agentImport.result : undefined;
  return { agentImport, agentPicks, imported: { agents } };
}
