import { useCallback, useEffect, useRef, useState } from "react";
import { apiErrorCode } from "@/app/api.ts";
import { confirmAction } from "@/app/confirmation.ts";
import { appCopy } from "@/app/copy.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import { isMissingRoute, keySaveFailure, type KeyCheckFailure } from "@/app/setupConnection.ts";
import { useButlerStore } from "@/app/store.ts";
import type { SavedCredentialView } from "@/app/types.ts";
import { deleteSavedKey, fetchModelCatalog, listSavedKeys, replaceSavedKey } from "../savedKeysApi";
import type { CredentialDeleteRule } from "../savedKeysUtils";

/** `unsupported`: an agent without the #217 routes; the section stays hidden. */
export type SavedKeysState = "loading" | "ready" | "error" | "unsupported";

/** The saved API keys, and replacing or deleting one (then the keys and the catalog reload). */
export function useSavedKeys() {
  const setModelCatalog = useButlerStore((state) => state.setModelCatalog);
  const [state, setState] = useState<SavedKeysState>("loading");
  const [credentials, setCredentials] = useState<SavedCredentialView[]>([]);
  const [busyId, setBusyId] = useState("");
  const mounted = useRef(true);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setState("loading");
    try {
      const list = await listSavedKeys();
      if (!mounted.current) return;
      setCredentials(list.credentials);
      setState("ready");
    } catch (error) {
      if (mounted.current && !quiet) setState(isMissingRoute(error) ? "unsupported" : "error");
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, [load]);

  async function refresh() {
    await load(true);
    try {
      setModelCatalog(await fetchModelCatalog());
    } catch {
      // The keys list is current; the catalog refreshes on the next load.
    }
  }

  /** Answers the first-run failure for a refused key, or null once replaced. */
  async function replace(credential: SavedCredentialView, name: string, apiKey: string): Promise<KeyCheckFailure | null> {
    try {
      await replaceSavedKey(credential.id, apiKey);
    } catch (error) {
      return keySaveFailure(apiErrorCode(error));
    }
    notifyStatus(appCopy.settings.savedKeys.replacedStatus(name), { id: "saved-key", tone: "ok" });
    await refresh();
    return null;
  }

  async function remove(credential: SavedCredentialView, name: string, rule: CredentialDeleteRule) {
    if (rule.kind === "blocked") return;
    const copy = appCopy.settings.savedKeys;
    const message = rule.kind === "force" ? copy.deleteConfirmModels(name, rule.count) : copy.deleteConfirm(name);
    const confirmed = await confirmAction(message, { title: copy.delete, confirmLabel: copy.delete, destructive: true });
    if (!confirmed) return;
    setBusyId(credential.id);
    try {
      await deleteSavedKey(credential.id, rule.kind === "force");
      notifyStatus(copy.deletedStatus(name), { id: "saved-key", tone: "ok" });
      await refresh();
    } catch (error) {
      notifyError(error, copy.errors.delete, { id: "saved-key" });
      await refresh();
    } finally {
      if (mounted.current) setBusyId("");
    }
  }

  return { state, credentials, busyId, reload: () => load(), replace, remove };
}
