import { useCallback, useEffect, useState } from "react";
import { getButlerAccount, type ButlerAccountStatus } from "@/app/butlerAccount";
import { appCopy } from "@/app/copy.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import type { SecurityView } from "@/app/types.ts";
import {
  getSecurity,
  isAdminRequiredError,
  isHostOnlyError,
  setAllowedHosts,
  setContentHosts,
  setRemoteAccess,
  setTunnel,
} from "./securityApi";

/**
 * `host-only`: the gateway refused a client on another computer (403
 * `loopback_required`). `admin-required`: this computer, but no valid admin
 * credential (403 `admin_credential_required`); Retry reads the file again.
 */
export type SecurityLoadState = "loading" | "error" | "host-only" | "admin-required" | "ready";

function refusedState(error: unknown): SecurityLoadState | null {
  if (isHostOnlyError(error)) return "host-only";
  if (isAdminRequiredError(error)) return "admin-required";
  return null;
}
export type SecurityAction = "toggle" | "hosts" | "tunnel";

const TOAST_ID = "settings-security";

export function useSecuritySettings() {
  const [view, setView] = useState<SecurityView | null>(null);
  const [load, setLoad] = useState<SecurityLoadState>("loading");
  const [busy, setBusy] = useState<SecurityAction | null>(null);

  const [account, setAccount] = useState<ButlerAccountStatus | null>(null);
  const [justEnabled, setJustEnabled] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const security = await getSecurity();
      setView(security);
      setLoad("ready");
      setAccount(security.tunnel ? await getButlerAccount().catch(() => null) : null);
    } catch (error) {
      setLoad(refusedState(error) ?? "error");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Resolves true when `task` succeeded. */
  async function run(action: SecurityAction, task: () => Promise<void>, failure: string): Promise<boolean> {
    setBusy(action);
    try {
      await task();
      return true;
    } catch (error) {
      const refused = refusedState(error);
      if (refused) setLoad(refused);
      else notifyError(error, failure, { id: TOAST_ID });
      return false;
    } finally {
      setBusy(null);
    }
  }

  return {
    view,
    load,
    busy,
    account,
    justEnabled,
    retry: () => {
      setLoad("loading");
      void refresh();
    },
    toggleTunnel: async (enabled: boolean) => {
      const saved = await run("tunnel", async () => {
        const tunnel = await setTunnel(enabled);
        setView((current) => current && { ...current, tunnel });
        setJustEnabled(enabled);
      }, appCopy.settings.errors.updateSettings);
      if (!saved) await refresh();
    },
    toggleRemoteAccess: (enabled: boolean) => run("toggle", async () => {
      await setRemoteAccess(enabled);
      setView((current) => current && { ...current, remote_access_enabled: enabled });
      notifyStatus(appCopy.settings.saved, { id: TOAST_ID, tone: "ok" });
      await refresh();
    }, appCopy.settings.errors.updateSettings),
    saveContentHosts: (hosts: string[]) => run("hosts", async () => {
      await setContentHosts(hosts);
      notifyStatus(appCopy.settings.saved, { id: TOAST_ID, tone: "ok" });
      await refresh();
    }, appCopy.settings.errors.updateSettings),
    saveAllowedHosts: (hosts: string[]) => run("hosts", async () => {
      await setAllowedHosts(hosts);
      notifyStatus(appCopy.settings.saved, { id: TOAST_ID, tone: "ok" });
      await refresh();
    }, appCopy.settings.errors.updateSettings),
  };
}
