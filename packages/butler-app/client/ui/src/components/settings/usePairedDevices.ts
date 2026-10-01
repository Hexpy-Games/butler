import { useCallback, useEffect, useRef, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { confirmAction } from "@/app/confirmation.ts";
import { notifyError } from "@/app/notifications.ts";
import { subscribePairedDevices } from "@/app/securityDeviceEvents.ts";
import { listPairedDevices, revokePairedDevice, type PairedDevice } from "./securityApi";

export function usePairedDevices() {
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [state, setState] = useState<"loading" | "error" | "ready">("loading");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const revision = useRef(0);
  const revoking = useRef(false);
  const refresh = useCallback(async () => {
    const request = ++revision.current;
    try {
      const next = await listPairedDevices();
      if (mounted.current && request === revision.current) {
        setDevices(next);
        setState("ready");
      }
    } catch {
      if (mounted.current && request === revision.current) setState("error");
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const unsubscribe = subscribePairedDevices(() => void refresh());
    return () => { mounted.current = false; revision.current++; unsubscribe(); };
  }, [refresh]);

  async function revoke(deviceId?: string) {
    if (revoking.current) return;
    revoking.current = true;
    setBusy(true);
    try {
      const copy = appCopy.settings.security;
      if (!deviceId && !await confirmAction(copy.revokeAllConfirm, {
        title: copy.revokeAllTitle, confirmLabel: copy.revokeAll, destructive: true,
      })) return;
      if (!mounted.current) return;
      await revokePairedDevice(deviceId);
      await refresh();
    } catch (error) {
      if (mounted.current) notifyError(error, appCopy.settings.security.revokeFailed);
    } finally {
      revoking.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return { devices, state, busy, refresh, revoke };
}
