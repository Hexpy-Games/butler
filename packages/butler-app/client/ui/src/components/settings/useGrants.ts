import { useCallback, useEffect, useRef, useState } from "react";
import { api, apiErrorCode } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import { confirmAction } from "@/app/confirmation.ts";
import { notifyStatus } from "@/app/notifications.ts";
import { subscribeAuthorityPermissions } from "@/app/authorityPermissionEvents.ts";
import { groupGrants, type GrantRecord, type GrantedRow } from "./grantRows";

export function useGrants() {
  const [rows, setRows] = useState<GrantedRow[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const mounted = useRef(false);
  const revision = useRef(0);
  const revoking = useRef(new Set<string>());
  const reload = useCallback(async (quiet = false) => {
    const request = ++revision.current;
    if (!quiet) setState("loading");
    try {
      const data = await api<{ permissions: GrantRecord[] }>("/authority-permissions");
      if (!mounted.current || revision.current !== request) return;
      setRows(groupGrants(data.permissions));
      setState("ready");
    } catch {
      if (mounted.current && revision.current === request) setState("error");
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void reload();
    let frame = 0;
    const unsubscribe = subscribeAuthorityPermissions(() => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; void reload(true); });
    });
    return () => { mounted.current = false; revision.current++; cancelAnimationFrame(frame); unsubscribe(); };
  }, [reload]);

  async function revoke(row: GrantedRow) {
    if (revoking.current.has(row.key)) return;
    const copy = appCopy.settings.grants;
    if (row.scope === "always" && !await confirmAction(copy.revokeAlwaysMessage, {
      title: copy.revokeAlwaysTitle, confirmLabel: copy.revoke, destructive: true,
      details: [{ label: copy.kind[row.kind], text: row.target || copy.targetUnknown }],
    })) return;
    revoking.current.add(row.key);
    setBusy(new Set(revoking.current));
    try {
      try {
        await api("/authority-permissions/revoke", { method: "POST", body: JSON.stringify({ grants: row.refs }) });
      } catch (error) {
        if (apiErrorCode(error) !== "authority_permission_not_found") throw error;
      }
      revision.current++;
      if (mounted.current) setRows(current => current.filter(item => item.key !== row.key));
      notifyStatus(copy.revoked, { tone: "ok" });
      await reload(true);
    } catch {
      notifyStatus(copy.revokeFailed, { tone: "error" });
    } finally {
      revoking.current.delete(row.key);
      if (mounted.current) setBusy(new Set(revoking.current));
    }
  }
  return { rows, state, busy, reload: () => reload(), revoke };
}
