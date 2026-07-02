import { useEffect, useState } from "react";
import { api } from "@/app/api.ts";
import type { AppInfoView } from "@/app/types.ts";

export function useDeveloperLogsAvailability(diagnosticsEnabled: boolean): boolean {
  const [appInfo, setAppInfo] = useState<AppInfoView | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<AppInfoView>("/app-info")
      .then((info) => {
        if (!cancelled) setAppInfo(info);
      })
      .catch(() => {
        if (!cancelled) setAppInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [diagnosticsEnabled]);

  const appDeveloperModeEnabled =
    appInfo?.developer_mode_enabled ?? diagnosticsEnabled;
  return appDeveloperModeEnabled && diagnosticsEnabled;
}
