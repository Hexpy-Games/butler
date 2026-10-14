import { useCallback, useEffect, useRef, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { confirmAction } from "@/app/confirmation.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import * as vault from "./vaultApi";

/** Settings → Browser → Payment methods, Profile details and purchase sites. */
export function useVault() {
  const [view, setView] = useState<vault.VaultView | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState<string | null>(null);
  const mounted = useRef(false);
  const reload = useCallback(async () => {
    try {
      const next = await vault.listVault();
      if (mounted.current) { setView(next); setState("ready"); }
    } catch {
      if (mounted.current) setState("error");
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => { mounted.current = false; };
  }, [reload]);

  const copy = appCopy.settings.vault;
  async function run(key: string, work: () => Promise<unknown>, done?: string) {
    if (busy) return false;
    setBusy(key);
    try {
      await work();
      if (done) notifyStatus(done, { tone: "ok" });
      await reload();
      return true;
    } catch (error) {
      notifyError(error, copy.failed);
      return false;
    } finally {
      if (mounted.current) setBusy(null);
    }
  }
  return {
    view, state, busy, reload,
    save: (kind: vault.VaultKind, id: string | null, input: Record<string, unknown>) =>
      run(id ?? `add-${kind}`, () => id ? vault.updateVaultItem(kind, id, input) : vault.addVaultItem(kind, input), copy.saved),
    remove: async (kind: vault.VaultKind, id: string, name: string) => {
      if (!await confirmAction(copy.deleteConfirm(name), { title: copy.delete, confirmLabel: copy.delete, destructive: true })) return;
      await run(id, () => vault.deleteVaultItem(kind, id));
    },
    sites: async (kind: vault.VaultKind, id: string, before: readonly string[], next: readonly string[]) => {
      const added = next.filter(site => !before.includes(site)), removed = before.filter(site => !next.includes(site));
      await run(id, async () => {
        for (const site of added) await vault.setVaultSite(kind, id, site, true);
        for (const site of removed) await vault.setVaultSite(kind, id, site, false);
      });
    },
    purchaseSites: async (before: readonly string[], next: readonly string[]) => {
      await run("purchase", async () => {
        for (const site of next.filter(item => !before.includes(item))) await vault.setPurchaseSite(site, true);
        for (const site of before.filter(item => !next.includes(item))) await vault.setPurchaseSite(site, false);
      });
    },
  };
}
