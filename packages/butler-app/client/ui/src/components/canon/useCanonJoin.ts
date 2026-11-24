import { useState } from "react";
import { api, apiErrorCode } from "@/app/api.ts";
import type { CanonSpace } from "@/app/canonApi.ts";
import { postCanonOnline, useCanonOnlineStore } from "@/app/canonOnline.ts";
import { appCopy } from "@/app/copy.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
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
    let project: ProjectSummary | undefined;
    try {
      try {
        ({ project } = await api<{ project: ProjectSummary }>("/projects", {
          method: "POST", body: JSON.stringify({ source: "scratch", display_name: copy.joinedName }),
        }));
        await postCanonOnline({ action: "join", project_id: project.id, token });
      } catch (error) {
        if (project) {
          await api(`/projects/${encodeURIComponent(project.id)}?permanent=true`, { method: "DELETE" }).catch(() => undefined);
          await app.refreshNavigation();
        }
        if (apiErrorCode(error) === "butler_account_signed_out") account.setSignedOut();
        else setFailed(true);
        return;
      }
      const { id } = project;
      try {
        const { spaces } = await postCanonOnline<{ spaces: CanonSpace[] }>({ action: "spaces" });
        const space = spaces.find(space => space.project_id === id);
        if (space) await api(`/projects/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ display_name: space.name }) });
      } catch { /* The join has already succeeded. */ }
      await useCanonOnlineStore.getState().refresh();
      await app.refreshNavigation();
      useProjectDashboardState.getState().update(id, { tab: "work" });
      await app.openProjectDashboard(id);
      notifyStatus(copy.joined, { tone: "ok" });
      onClose();
    } catch (error) {
      notifyError(error, appCopy.butlerAccount.failed);
    } finally {
      setBusy(false);
    }
  };
  return { account, busy, failed, submit };
}
