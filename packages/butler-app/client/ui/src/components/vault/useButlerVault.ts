import { useEffect, useRef, useState } from "react";
import { confirmAction } from "@/app/confirmation.ts";
import { appCopy } from "@/app/copy.ts";
import { isMissingRoute } from "@/app/setupConnection.ts";
import type { ButlerVaultView } from "@/app/types.ts";
import { declineButlerVault, enableButlerVault, fetchButlerVault } from "./butlerVaultApi";

export function useButlerVault() {
  const [state, setState] = useState<"loading" | "ready" | "unsupported" | "error">("loading");
  const [view, setView] = useState<ButlerVaultView | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void fetchButlerVault().then((result) => {
      if (!mounted.current) return;
      setView(result);
      setState("ready");
    }).catch((error: unknown) => {
      if (mounted.current) setState(isMissingRoute(error) ? "unsupported" : "error");
    });
    return () => { mounted.current = false; };
  }, []);

  async function enable(): Promise<boolean> {
    setBusy(true);
    try {
      const result = await enableButlerVault();
      if (mounted.current) setView(result);
      return true;
    } catch {
      return false;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function decline(): Promise<boolean> {
    const copy = appCopy.butlerVault;
    if (!await confirmAction(copy.declineNote, {
      title: copy.declineTitle, confirmLabel: copy.declineConfirm,
      details: copy.risks.map((text) => ({ text })), destructive: false,
    })) return false;
    setBusy(true);
    try {
      const result = await declineButlerVault();
      if (mounted.current) setView(result);
      return result.declined;
    } catch {
      return false;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return { state, view, busy, enable, decline };
}
