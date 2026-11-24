import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/app/api.ts";
import { subscribeAuthorityPermissions } from "@/app/authorityPermissionEvents.ts";
import { appCopy } from "@/app/copy.ts";
import { notifyStatus } from "@/app/notifications.ts";

interface AllowedFolder { rule_id: string; path: string; created_at: string }

export function useAllowedFolders() {
  const [folders, setFolders] = useState<AllowedFolder[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  const reload = useCallback(async () => {
    const request = ++revision.current;
    try {
      const result = await api<{ folders: AllowedFolder[] }>("/allowed-folders");
      if (revision.current !== request) return;
      setFolders(result.folders);
      setState("ready");
    } catch {
      if (revision.current === request) setState("error");
    }
  }, []);
  useEffect(() => {
    void reload();
    const unsubscribe = subscribeAuthorityPermissions(() => void reload());
    return () => { revision.current++; unsubscribe(); };
  }, [reload]);

  async function mutate(path: "/allowed-folders" | "/allowed-folders/remove", input: Record<string, string>) {
    setBusy(true);
    try {
      await api(path, { method: "POST", body: JSON.stringify(input) });
      await reload();
      return true;
    } catch {
      notifyStatus(appCopy.settings.allowedFolders.refused, { tone: "error" });
      return false;
    } finally { setBusy(false); }
  }

  return {
    folders, state, busy, reload,
    add: (path: string) => mutate("/allowed-folders", { path }),
    remove: (rule_id: string) => mutate("/allowed-folders/remove", { rule_id }),
  };
}
