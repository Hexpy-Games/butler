import { useEffect, useRef, useState } from "react";
import { confirmAction } from "@/app/confirmation.ts";
import { appCopy } from "@/app/copy.ts";
import { isMissingRoute } from "@/app/setupConnection.ts";
import type { ButlerVaultView } from "@/app/types.ts";
import { changeButlerVaultPassword, declineButlerVault, enableButlerVault, fetchButlerVault, unlockButlerVault } from "./butlerVaultApi";

type VaultResult = { ok: true } | { ok: false; code: "vault_wrong_password" | "vault_weak_password" | "failed" };

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

  async function update(operation: () => Promise<ButlerVaultView>): Promise<VaultResult> {
    setBusy(true);
    try {
      const result = await operation();
      if (mounted.current) setView(result);
      return { ok: true };
    } catch (error: unknown) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      return { ok: false, code: code === "vault_wrong_password" || code === "vault_weak_password" ? code : "failed" };
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

  return { state, view, busy, decline,
    enable: (password?: string) => update(() => enableButlerVault(password)),
    unlock: (password: string) => update(() => unlockButlerVault(password)),
    changePassword: (current: string, next: string) => update(() => changeButlerVaultPassword(current, next)),
  };
}
