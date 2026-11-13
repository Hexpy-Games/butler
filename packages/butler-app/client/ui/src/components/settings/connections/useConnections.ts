import { useCallback, useEffect, useRef, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { notifyStatus } from "@/app/notifications.ts";
import { useConnectorVersion } from "./connectorEvents";
import * as connections from "./connectionsApi";

export function useConnections() {
  const [view, setView] = useState<connections.ConnectorsView | null>(null);
  const [rules, setRules] = useState<Awaited<ReturnType<typeof connections.listRules>>["rules"]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const checked = useRef(false);
  const version = useConnectorVersion(s => s.version);
  const reload = useCallback(async () => {
    try {
      const [next, nextRules] = await Promise.all([connections.listConnectors(), connections.listRules()]);
      if (mounted.current) { setView(next); setRules(nextRules.rules); setState("ready"); }
    } catch {
      if (mounted.current) setState("error");
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    if (!checked.current) {
      checked.current = true;
      void connections.listPlugins().then(async plugins => {
        if (plugins.plugins.some(plugin => plugin.id === "mail")) {
          await connections.ensureBundledPlugin("mail");
          await reload();
        }
      }).catch(() => {});
    }
    return () => { mounted.current = false; };
  }, [reload]);
  useEffect(() => { void reload(); }, [reload, version]);

  async function run(work: () => Promise<unknown>, done?: string, failed = appCopy.settings.connections.actionFailed) {
    if (busy) return false;
    setBusy(true);
    try {
      await work();
      if (done) notifyStatus(done, { tone: "ok" });
      await reload();
      return true;
    } catch {
      notifyStatus(failed, { tone: "error" });
      await reload();
      return false;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return {
    view, rules, state, busy, reload,
    add: (input: connections.MailAccountInput) => run(() => connections.addMailAccount(input), appCopy.settings.connections.connectedToast, appCopy.settings.connections.failed),
    retry: (id: string) => run(() => connections.retryAccount(id, view!.revision)),
    remove: (id: string) => run(() => connections.removeAccount(id, view!.revision)),
    deleteRule: (id: string) => run(() => connections.deleteRule(id)),
  };
}
