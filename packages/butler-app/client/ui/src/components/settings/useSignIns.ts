import { useCallback, useEffect, useRef, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { confirmAction } from "@/app/confirmation.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import * as signIns from "./signInsApi";

/** Settings → Security → Sign-ins: rows, availability and the row actions. */
export function useSignIns() {
  const [view, setView] = useState<signIns.SignInsView | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState<string | null>(null);
  const mounted = useRef(false);
  const reload = useCallback(async () => {
    try {
      const next = await signIns.listSignIns();
      if (mounted.current) { setView(next); setState("ready"); }
    } catch {
      if (mounted.current) setState("error");
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => { mounted.current = false; };
  }, [reload]);

  async function run(key: string, work: () => Promise<unknown>, done?: string) {
    if (busy) return false;
    setBusy(key);
    try {
      await work();
      if (done) notifyStatus(done, { tone: "ok" });
      await reload();
      return true;
    } catch (error) {
      notifyError(error, appCopy.settings.signIns.failed);
      return false;
    } finally {
      if (mounted.current) setBusy(null);
    }
  }
  const copy = appCopy.settings.signIns;
  return {
    view, state, busy, reload,
    add: (input: { site: string; username: string; password: string }) => run("add", () => signIns.addSignIn(input), copy.saved),
    policy: (id: string, policy: signIns.SignInPolicy) => run(id, () => signIns.setSignInPolicy(id, policy)),
    allConversations: (site: string, value: boolean) => run(site, () => signIns.setAllConversations(site, value)),
    deletePassword: async (row: signIns.SignInSiteRow) => {
      if (!row.entry || !await confirmAction(copy.deleteConfirm(row.site), { title: copy.deletePassword, confirmLabel: copy.deletePassword, destructive: true })) return;
      const id = row.entry.id;
      await run(row.site, () => signIns.deleteSignIn(id));
    },
    signOut: (site: string) => run(site, () => signIns.signOutSite(site), copy.signedOut),
    revoke: async (site: string) => {
      if (!await confirmAction(copy.revokeConfirm(site), { title: copy.revoke, confirmLabel: copy.revoke, destructive: true })) return;
      await run(site, () => signIns.revokeSite(site), copy.revoked);
    },
  };
}
