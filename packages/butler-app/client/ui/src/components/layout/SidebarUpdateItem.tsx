import { useShallow } from "zustand/react/shallow";
import { appCopy, useAppLocale } from "@/app/copy";
import { applyComponentUpdate } from "@/app/updateCommands";
import { notifyStatus } from "@/app/notifications";
import { useButlerStore } from "@/app/store";
import {
  ButtonContainer,
  CircleAlert,
  IconButton,
  NavRow,
  ProgressRing,
  RotateCcw,
} from "@/butler-ds";
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
  const icon = stage === "failed" ? <CircleAlert /> : stage === "ready"
    ? <ProgressRing size="sidebar" value={1} tone="success" aria-hidden />
    : <ProgressRing size="sidebar" aria-hidden value={(percent ?? 0) / 100} indeterminate={percent === null} />;
  return <NavRow dataTestClass="sidebar-update-row" icon={icon} label={label}
    ariaLabel={percent === null ? label : `${label} ${percent}%`}
    badge={percent === null ? undefined : `${percent}%`}
    actions={stage === "ready" ? <ButtonContainer size="icon-sm" wrap={false}
      onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      <IconButton data-test-class="sidebar-update-restart" label={copy.restart}
        disabled={["deferred", "preparing", "restarting", "choice_required"].includes(restart.status)}
        onClick={() => {
          void applyComponentUpdate(component)
            .catch(() => notifyStatus(appCopy.settings.updateErrors.generic, { tone: "error", id: "app-update" }));
        }}>
        <RotateCcw />
      </IconButton>
    </ButtonContainer> : undefined}
    onClick={() => openSettings("updates")} />;
}
