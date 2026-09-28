import { useEffect, useMemo, useState } from "react";
import { fetchLocalModelServers } from "@/app/setupConnection.ts";
import { localModelOptions, type LocalModelServerView } from "@/app/setupProviders.ts";

/**
 * Local model servers (Ollama, LM Studio) found by the agent. Loads when the
 * AI list opens, again once Butler is ready, and on "Check again".
 */
export function useLocalModelServers({ enabled, agentReady }: { enabled: boolean; agentReady: boolean }) {
  const [servers, setServers] = useState<LocalModelServerView[]>([]);
  const [checking, setChecking] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    setChecking(true);
    fetchLocalModelServers()
      .then((next) => {
        if (!cancelled) setServers(next);
      })
      .catch(() => {
        if (!cancelled) setServers([]);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, agentReady, attempt]);

  const options = useMemo(() => localModelOptions(servers), [servers]);
  return {
    checking,
    options,
    reachable: servers.some((server) => server.reachable),
    serverNames: servers.filter((server) => server.reachable).map((server) => server.label || server.id),
    rescan: () => setAttempt((current) => current + 1),
  };
}
