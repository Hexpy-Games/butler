import { useCallback, useEffect, useState } from "react";
import { getButlerAccount } from "@/app/butlerAccount.ts";

export function useCanonOnlineAccount() {
  const [account, setAccount] = useState<{ state: "loading" | "in" | "out"; accountId?: string }>({ state: "loading" });
  const recheck = useCallback(async () => {
    const status = await getButlerAccount().catch(() => null);
    setAccount(status?.signed_in ? { state: "in", accountId: status.account.id } : { state: "out" });
  }, []);
  useEffect(() => { void recheck(); }, [recheck]);
  const setSignedOut = useCallback(() => setAccount({ state: "out" }), []);
  return { ...account, recheck, setSignedOut };
}
