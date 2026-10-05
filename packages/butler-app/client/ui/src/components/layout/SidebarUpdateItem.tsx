import { useShallow } from "zustand/react/shallow";
import { appCopy, useAppLocale } from "@/app/copy";
import { applyComponentUpdate } from "@/app/updateCommands";
import { notifyStatus } from "@/app/notifications";
import { useButlerStore } from "@/app/store";
import { Button, CircleAlert, NavRow, ProgressRing } from "@/butler-ds";
import { useAppUpdateState } from "@/hooks/useAppUpdateState";
import { updatePercent, useUpdateProgressStore } from "@/stores/updateProgressStore";

export function SidebarUpdateItem() {
  useAppLocale();
  const restart = useAppUpdateState();
  const { stage, percent, component } = useUpdateProgressStore(useShallow(({ progress }) => ({
    stage: progress?.error_code === "update_cancelled" ? "idle" : progress?.stage ?? "idle",
    percent: updatePercent(progress), component: progress?.component ?? "app",
  })));
  const openSettings = useButlerStore((state) => state.openSettings);
  if (["idle", "completed"].includes(stage)) return null;
  const copy = appCopy.shell.update;
  const label = stage === "downloading" ? copy.downloading : stage === "ready" ? copy.ready
    : stage === "failed" ? copy.failed : copy.working;
  const icon = stage === "failed" ? <CircleAlert /> : <ProgressRing size="sidebar" aria-hidden
    value={stage === "ready" ? 1 : (percent ?? 0) / 100}
    indeterminate={stage !== "ready" && percent === null} />;
  return <NavRow dataTestClass="sidebar-update-row" icon={icon} label={label}
    ariaLabel={percent === null ? label : `${label} ${percent}%`}
    badge={percent === null ? undefined : `${percent}%`}
    actions={stage === "ready" ? <Button size="xs" variant="outline"
      disabled={["deferred", "preparing", "restarting", "choice_required"].includes(restart.status)}
      onClick={(event) => {
        event.stopPropagation();
        void applyComponentUpdate(component)
          .catch(() => notifyStatus(appCopy.settings.updateErrors.generic, { tone: "error", id: "app-update" }));
      }}>{copy.restart}</Button> : undefined}
    onClick={() => openSettings("updates")} />;
}
