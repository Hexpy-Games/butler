import { useState } from "react";
import { api, apiErrorCode } from "@/app/api.ts";
import type { CanonSpace } from "@/app/canonApi.ts";
import { postCanonOnline, useCanonOnlineStore } from "@/app/canonOnline.ts";
import { appCopy } from "@/app/copy.ts";
import { notifyStatus } from "@/app/notifications.ts";
import { useProjectDashboardState } from "@/app/projectDashboardState.ts";
import { useButlerStore } from "@/app/store.ts";
import type { ProjectSummary } from "@/app/types.ts";
import { useCanonOnlineAccount } from "./useCanonOnlineAccount.ts";

export function useCanonJoin(onClose: () => void) {
  const account = useCanonOnlineAccount();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const submit = async (code: string) => {
    const token = code.trim();
    if (!token || busy) return;
    setBusy(true);
    setFailed(false);
    const copy = appCopy.canon.online;
    const app = useButlerStore.getState();
    try {
      const { project } = await api<{ project: ProjectSummary }>("/projects", {
        method: "POST", body: JSON.stringify({ source: "scratch", display_name: copy.joinedName }),
      });
      const path = `/projects/${encodeURIComponent(project.id)}`;
      try {
        await postCanonOnline({ action: "join", project_id: project.id, token });
      } catch (error) {
        await api(path + "?permanent=true", { method: "DELETE" }).catch(() => undefined);
        await app.refreshNavigation();
        if (apiErrorCode(error) === "butler_account_signed_out") account.setSignedOut();
        else setFailed(true);
        return;
      }
      try {
        const { spaces } = await postCanonOnline<{ spaces: CanonSpace[] }>({ action: "spaces" });
        const space = spaces.find(space => space.project_id === project.id);
        if (space) await api(path, { method: "PATCH", body: JSON.stringify({ display_name: space.name }) });
      } catch { /* The join has already succeeded. */ }
      await useCanonOnlineStore.getState().refresh();
      await app.refreshNavigation();
      useProjectDashboardState.getState().update(project.id, { tab: "work" });
      app.openProjectDashboard(project.id);
      notifyStatus(copy.joined, { tone: "ok" });
      onClose();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return { account, busy, failed, submit };
}
