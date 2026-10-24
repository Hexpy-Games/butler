import { useEffect, useState } from "react";
import { api } from "@/app/api";
import { appCopy } from "@/app/copy";
import { notifyStatus } from "@/app/notifications";
import type { UsageHistoryView } from "@/app/types";

export function useUsageHistory(revision: number) {
  const [history, setHistory] = useState<UsageHistoryView | null>(null);
  useEffect(() => {
    let cancelled = false;
    api<UsageHistoryView>("/usage-history").then(next => {
      if (!cancelled) setHistory(next);
    }).catch(() => {
      if (!cancelled) notifyStatus(appCopy.interfacePanels.usageFailed, { tone: "error", id: "usage-history" });
    });
    return () => { cancelled = true; };
  }, [revision]);
  return history;
}
