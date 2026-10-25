import { useCallback, useEffect, useRef, useState } from "react";
import { publishChatGptEvent } from "@/app/chatGptEvents";
import { confirmAction } from "@/app/confirmation";
import { appCopy } from "@/app/copy";
import { notifyError, notifyStatus } from "@/app/notifications";
import { isMissingRoute } from "@/app/setupConnection";
import { useButlerStore } from "@/app/store";
import { fetchModelCatalog } from "../savedKeysApi";
import { listOauthCredentials, removeOauthCredential, type OauthCredential } from "../securityApi";

export function useConnectedAccounts() {
  const [state, setState] = useState<"loading" | "ready" | "error" | "unsupported">("loading");
  const [credentials, setCredentials] = useState<OauthCredential[]>([]);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const removing = useRef(false);
  const setModelCatalog = useButlerStore((store) => store.setModelCatalog);
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setState("loading");
    try {
      const result = await listOauthCredentials();
      if (!mounted.current) return;
      setCredentials(result.credentials);
      setState("ready");
    } catch (error) {
      if (mounted.current) setState(isMissingRoute(error) ? "unsupported" : "error");
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, [load]);

  async function refresh() {
    await load(true);
    // All mounted account views (including notices) re-read the current account.
    publishChatGptEvent({ type: "setup.chatgpt_account_changed" });
    try { setModelCatalog(await fetchModelCatalog()); }
    catch { /* The next catalog read recovers independently of credential removal. */ }
  }

  async function remove(credential: OauthCredential, name: string) {
    if (removing.current) return;
    removing.current = true;
    const copy = appCopy.settings.connectedAccounts;
    try {
      const confirmed = await confirmAction(copy.confirm(name), {
        title: copy.signOut, confirmLabel: copy.signOut, destructive: true,
      });
      if (!confirmed) return;
      setBusy(true);
      try {
        const result = await removeOauthCredential(credential.id);
        notifyStatus(result.revoked === false ? copy.revokeUnconfirmed : copy.done, { id: "connected-account", tone: "ok" });
      } catch (error) {
        notifyError(error, copy.error, { id: "connected-account" });
      }
      await refresh();
    } finally {
      removing.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return { state, credentials, busy, reload: () => load(), remove };
}
