import { useCallback, useEffect, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { confirmAction } from "@/app/confirmation.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import type { SecurityView } from "@/app/types.ts";
import {
  getSecurity,
  isHostOnlyError,
  revealConnectionCode,
  rotateConnectionCode,
  setRemoteAccess,
} from "./securityApi";

/** `host-only`: the gateway refused a non-loopback client (403). */
export type SecurityLoadState = "loading" | "error" | "host-only" | "ready";
export type SecurityAction = "toggle" | "reveal" | "copy" | "rotate";

const TOAST_ID = "settings-security";

export function useSecuritySettings() {
  const [view, setView] = useState<SecurityView | null>(null);
  const [load, setLoad] = useState<SecurityLoadState>("loading");
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState<SecurityAction | null>(null);

  const refresh = useCallback(async () => {
    try {
      setView(await getSecurity());
      setLoad("ready");
    } catch (error) {
      setLoad(isHostOnlyError(error) ? "host-only" : "error");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(action: SecurityAction, task: () => Promise<void>, failure: string) {
    setBusy(action);
    try {
      await task();
    } catch (error) {
      if (isHostOnlyError(error)) setLoad("host-only");
      else notifyError(error, failure, { id: TOAST_ID });
    } finally {
      setBusy(null);
    }
  }

  const copy = appCopy.settings.security;
  return {
    view,
    load,
    revealed,
    busy,
    retry: () => {
      setLoad("loading");
      void refresh();
    },
    toggleRemoteAccess: (enabled: boolean) => run("toggle", async () => {
      await setRemoteAccess(enabled);
      setView((current) => current && { ...current, remote_access_enabled: enabled });
      notifyStatus(appCopy.settings.saved, { id: TOAST_ID, tone: "ok" });
      await refresh();
    }, appCopy.settings.errors.updateSettings),
    toggleReveal: () => revealed
      ? setRevealed(null)
      : run("reveal", async () => setRevealed(await revealConnectionCode()), copy.revealFailed),
    copyCode: () => run("copy", async () => {
      await navigator.clipboard.writeText(revealed ?? await revealConnectionCode());
      notifyStatus(copy.copied, { id: TOAST_ID, tone: "ok" });
    }, appCopy.interfacePanels.copyFailed),
    rotate: async () => {
      const accepted = await confirmAction(copy.rotateConfirm, {
        title: copy.rotateTitle,
        confirmLabel: copy.rotate,
        destructive: true,
      });
      if (!accepted) return;
      await run("rotate", async () => {
        await rotateConnectionCode();
        setRevealed(null);
        notifyStatus(copy.rotated, { id: TOAST_ID, tone: "ok" });
        await refresh();
      }, copy.rotateFailed);
    },
  };
}
