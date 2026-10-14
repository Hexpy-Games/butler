import { useEffect, useRef, useState } from "react";
import { apiErrorCode } from "@/app/api";
import { listAgentImportSources, startAgentImport, type AgentImportCounts, type AgentImportRequest, type AgentImportSource } from "../settings/agentImportApi";

/** Per-source item choice; a source without one imports everything it holds. */
export type AgentImportSelection = Omit<AgentImportRequest, "source">;

/** Component-local state: counts and an opaque receipt only. */
export function useAgentImport(enabled = true) {
  const [sources, setSources] = useState<AgentImportSource[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AgentImportCounts | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  /** The latest counts of each imported source, for a per-tool result. */
  const [bySource, setBySource] = useState<Record<string, AgentImportCounts>>({});
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    if (!enabled) return () => { mounted.current = false; };
    void listAgentImportSources()
      .then(view => { if (mounted.current) setSources(view.sources); })
      .catch(e => { if (mounted.current) { setSources([]); setError(apiErrorCode(e) ?? "import_unreadable"); } });
    return () => { mounted.current = false; };
  }, [enabled]);
  async function work(task: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await task(); } catch (e) { if (mounted.current) setError(apiErrorCode(e) ?? "import_failed"); }
    finally { if (mounted.current) setBusy(false); }
  }
  const run = (keys: string | string[], selections?: Record<string, AgentImportSelection>) => work(async () => {
    const sources = typeof keys === "string" ? [keys] : keys;
    setSelected(sources[0] ?? null);
    const total: AgentImportCounts = { run_id: "", instructions: 0, servers: 0, needs_secret: 0, instructions_existing: 0, servers_existing: 0, skipped: 0 };
    if (result) Object.assign(total, result, { error: undefined });
    for (const key of sources) {
      const counts = await startAgentImport(key, selections?.[key]);
      if (mounted.current) setBySource(prior => ({ ...prior, [key]: counts }));
      total.run_id = counts.run_id;
      total.instructions += counts.instructions; total.servers += counts.servers; total.needs_secret += counts.needs_secret;
      total.instructions_existing += counts.instructions_existing; total.servers_existing += counts.servers_existing; total.skipped += counts.skipped;
      total.error = counts.error;
      if (!mounted.current) return;
      setResult({ ...total }); setError(counts.error ?? null);
      if (counts.error) break;
    }
  });
  const more = () => { setResult(null); setBySource({}); setError(null); };
  return { sources, busy, error, result, bySource, selected, run, more };
}
