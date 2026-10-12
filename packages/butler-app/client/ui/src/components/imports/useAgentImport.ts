import { useEffect, useRef, useState } from "react";
import { apiErrorCode } from "@/app/api";
import { listAgentImportSources, startAgentImport, undoAgentImport, type AgentImportCounts, type AgentImportSource } from "../settings/agentImportApi";

/** Component-local state: counts and an opaque receipt only. */
export function useAgentImport(enabled = true) {
  const [sources, setSources] = useState<AgentImportSource[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AgentImportCounts | null>(null);
  const [undone, setUndone] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const mounted = useRef(true);
  const receipts = useRef<string[]>([]);
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
  const run = (keys: string | string[]) => work(async () => {
    const sources = typeof keys === "string" ? [keys] : keys;
    setSelected(sources[0] ?? null); setUndone(false);
    if (undone) receipts.current = [];
    const total: AgentImportCounts = { run_id: "", instructions: 0, servers: 0, needs_secret: 0, instructions_existing: 0, servers_existing: 0, skipped: 0 };
    if (result && !undone) Object.assign(total, result, { error: undefined });
    for (const key of sources) {
      const counts = await startAgentImport(key);
      receipts.current.push(counts.run_id);
      total.run_id = counts.run_id;
      total.instructions += counts.instructions; total.servers += counts.servers; total.needs_secret += counts.needs_secret;
      total.instructions_existing += counts.instructions_existing; total.servers_existing += counts.servers_existing; total.skipped += counts.skipped;
      total.error = counts.error;
      if (!mounted.current) return;
      setResult({ ...total }); setError(counts.error ?? null);
      if (counts.error) break;
    }
  });
  const undo = () => work(async () => {
    while (receipts.current.length) {
      await undoAgentImport(receipts.current[0]!);
      receipts.current.shift();
    }
    if (mounted.current) setUndone(true);
  });
  const more = () => { receipts.current = []; setResult(null); setError(null); setUndone(false); };
  return { sources, busy, error, result, undone, selected, run, undo, more };
}

