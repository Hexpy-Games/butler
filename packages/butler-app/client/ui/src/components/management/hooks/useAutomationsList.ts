import { useEffect, useState } from "react";
import { api } from "@/app/api.ts";
import { notifyError } from "@/app/notifications.ts";
import type { AutomationSummary, StatusPill } from "@/app/types.ts";

export function useAutomationsList(reportStatus: (status: StatusPill) => void) {
  const [automations, setAutomations] = useState<AutomationSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await api<{ automations: AutomationSummary[] }>(
          "/automations",
        );
        if (!cancelled) setAutomations(data.automations ?? []);
      } catch (error) {
        if (!cancelled) {
          notifyError(error, "Automation load failed", {
            id: "automation-load",
          });
          reportStatus({ label: "ready", tone: "ok" });
        }
      }
    }
    load();
    const timer = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [reportStatus]);

  async function refresh() {
    const data = await api<{ automations: AutomationSummary[] }>(
      "/automations",
    );
    setAutomations(data.automations ?? []);
  }

  return { automations, refresh };
}