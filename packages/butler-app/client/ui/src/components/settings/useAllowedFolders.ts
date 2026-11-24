import { useCallback, useEffect, useState } from "react";
import { api } from "@/app/api.ts";
import { subscribeAuthorityPermissions } from "@/app/authorityPermissionEvents.ts";
import { appCopy } from "@/app/copy.ts";
import { notifyStatus } from "@/app/notifications.ts";

interface AllowedFolder { rule_id: string; path: string; created_at: string }

export function useAllowedFolders() {
  const [folders, setFolders] = useState<AllowedFolder[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const reload = useCallback(async () => {
    try {
      const result = await api<{ folders: AllowedFolder[] }>("/allowed-folders");
      setFolders(result.folders);
      setState("ready");
    } catch { setState("error"); }
  }, []);
  useEffect(() => {
    void reload();
    return subscribeAuthorityPermissions(() => void reload());
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
