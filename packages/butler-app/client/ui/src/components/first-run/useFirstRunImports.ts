import { useEffect, useRef, useState } from "react";
import { useAgentImport } from "../imports/useAgentImport";
import { listSignIns, type BrowserImportCounts } from "../settings/signInsApi";
import { useBrowserImport } from "../imports/useBrowserImport";

export function useFirstRunImports(enabled: boolean) {
  const started = useRef(false);
  if (enabled) started.current = true;
  const active = started.current;
  const agentImport = useAgentImport(active);
  const browserImport = useBrowserImport(() => {}, active);
  const [keychain, setKeychain] = useState(false);
  const [runs, setRuns] = useState<Record<string, BrowserImportCounts>>({});
  useEffect(() => {
    if (!active) return;
    let live = true;
    void listSignIns().then(view => { if (live) setKeychain(view.available); }).catch(() => {});
    return () => { live = false; };
  }, [active]);
  useEffect(() => {
    const result = browserImport.result;
    if (!result) return;
    setRuns(prior => {
      const next = { ...prior };
      if (browserImport.undone) delete next[result.run_id];
      else next[result.run_id] = result;
      return next;
    });
  }, [browserImport.result, browserImport.undone]);
  const agents = agentImport.result && !agentImport.undone ? agentImport.result : undefined;
  const browsers = Object.values(runs).reduce((total, run) => ({
    bookmarks: total.bookmarks + run.bookmarks, passwords: total.passwords + run.passwords,
    history: total.history + (run.history ?? 0),
  }), { bookmarks: 0, passwords: 0, history: 0 });
  return { agentImport, browserImport, keychain, imported: { agents, browsers } };
}
