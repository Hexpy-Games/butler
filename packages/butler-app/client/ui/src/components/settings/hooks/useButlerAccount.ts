import { useCallback, useEffect, useRef, useState } from "react";
import { apiErrorCode } from "@/app/api";
import {
  getButlerAccount, listButlerAccountDevices, revokeButlerAccountDevice, setButlerAccountDevPlan, signOutButlerAccount,
  startButlerAccount, verifyButlerAccount, type ButlerAccountDevice, type ButlerAccountStatus,
} from "@/app/butlerAccount";
import { confirmAction } from "@/app/confirmation";
import { appCopy } from "@/app/copy";
import { notifyError, notifyStatus } from "@/app/notifications";
import { isMissingRoute } from "@/app/setupConnection";

export function useButlerAccount() {
  const [state, setState] = useState<"loading" | "ready" | "error" | "unsupported">("loading");
  const [status, setStatus] = useState<ButlerAccountStatus | null>(null);
  const [devices, setDevices] = useState<ButlerAccountDevice[]>([]);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const acting = useRef(false);
  const copy = appCopy.butlerAccount;
  const load = useCallback(async function load(devicesOnly = false) {
    if (!devicesOnly) setState("loading");
    let readingStatus = !devicesOnly;
    try {
      const next = devicesOnly ? null : await getButlerAccount();
      if (!mounted.current) return;
      if (next) setStatus(next);
      readingStatus = false;
      const rows = next?.signed_in === false ? [] : (await listButlerAccountDevices()).devices;
      if (!mounted.current) return;
      setDevices(rows);
      setState("ready");
    } catch (error) {
      if (!mounted.current) return;
      if (apiErrorCode(error) === "butler_account_signed_out") await load();
      else setState(readingStatus && isMissingRoute(error) ? "unsupported" : "error");
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, [load]);

  async function update<T>(operation: () => Promise<T>, reload?: "status" | "devices",
    confirmation?: { message: string; label: string; done: string }): Promise<{ ok: true; value: T } | { ok: false; code?: string }> {
    if (acting.current) return { ok: false };
    acting.current = true;
    try {
      if (confirmation && !await confirmAction(confirmation.message, {
        title: confirmation.label, confirmLabel: confirmation.label, destructive: true,
      })) return { ok: false };
      setBusy(true);
      const value = await operation();
      if (confirmation) notifyStatus(confirmation.done, { id: "butler-account", tone: "ok" });
      if (reload) await load(reload === "devices");
      return { ok: true, value };
    } catch (error) {
      const code = apiErrorCode(error);
      if (confirmation) notifyError(error, copy.failed, { id: "butler-account" });
      if (code === "butler_account_signed_out") await load();
      return { ok: false, code };
    } finally {
      acting.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return {
    state, status, devices, busy, reload: () => load(),
    start: (email: string) => update(() => startButlerAccount(email)),
    verify: (email: string, code: string) => update(() => verifyButlerAccount(email, code), "status"),
    setDevPlan: async (plan: "free" | "plus") => {
      const result = await update(async () => {
        const next = await setButlerAccountDevPlan(plan);
        if (mounted.current) setStatus(next);
      });
      if (!result.ok) notifyError(result, copy.failed, { id: "butler-account" });
      return result;
    },
    signOut: () => update(signOutButlerAccount, "status", {
      message: copy.signOutConfirm, label: copy.signOut, done: copy.signedOut,
    }),
    revoke: (device: ButlerAccountDevice) => update(() => revokeButlerAccountDevice(device.id), "devices", {
      message: copy.revokeConfirm(device.name), label: copy.revoke, done: copy.revoked,
    }),
  };
}
