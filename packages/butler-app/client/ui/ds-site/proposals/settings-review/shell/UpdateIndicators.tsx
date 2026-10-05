import { appCopy, useAppLocale } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import {
  Button, CircleAlert, ContextDonutButton, NavRow, ProgressMeter, RefreshCcw, Settings, Spinner, Tooltip,
} from "@/butler-ds";
import { SidebarItem } from "@/components/layout/SidebarItem";
import { t } from "../proposedCopy";
import type { ProposalLocale, UpdateStage } from "../state";
import { UPDATE_BYTES } from "../updates/updateFixture";

// NEW: the three outside-Settings update indicators. Each opens Settings › Updates. They render
// only while an update is running, ready or failed (never for idle / up to date).

const PERCENT = Math.floor((UPDATE_BYTES.done / UPDATE_BYTES.total) * 100);

export function updateVisible(stage: UpdateStage): boolean {
  return !["available", "upToDate"].includes(stage);
}

function label(stage: UpdateStage, locale: ProposalLocale): string {
  if (stage === "downloading" || stage === "downloadingUnknown") return t(locale, "shell.update.downloading");
  if (stage === "ready" || stage === "deferred") return t(locale, "shell.update.ready");
  if (stage === "failed") return t(locale, "shell.update.failed");
  return t(locale, "shell.update.working");
}

/** A · A sidebar footer row above Settings: SidebarItem (NavRow) with a bare ProgressMeter as its second line. */
export function UpdateSidebarRow({ stage, locale }: { stage: UpdateStage; locale: ProposalLocale }) {
  useAppLocale();
  const openSettings = useButlerStore((state) => state.openSettings);
  if (!updateVisible(stage)) return null;
  const icon = stage === "failed" ? <CircleAlert /> : stage === "ready" || stage === "deferred" ? <RefreshCcw /> : <Spinner size={14} />;
  return (
    <NavRow
      dataTestClass="sidebar-update-row"
      icon={icon}
      label={label(stage, locale)}
      badge={stage === "downloading" ? `${PERCENT}%` : undefined}
      meta={stage === "downloading" ? <ProgressMeter bare value={PERCENT} ariaLabel={label(stage, locale)} /> : undefined}
      actions={stage === "ready" ? (
        <Button type="button" size="xs" variant="outline" onClick={(event) => event.stopPropagation()}>
          {t(locale, "settings.updateProgress.restart")}
        </Button>
      ) : undefined}
      onClick={() => openSettings("updates")}
    />
  );
}

/** C · The existing Settings row with a badge; everything else unchanged. */
export function SettingsBadgeItem({ stage, locale }: { stage: UpdateStage; locale: ProposalLocale }) {
  useAppLocale();
  const active = useButlerStore((state) => state.view.kind === "settings");
  const openSettings = useButlerStore((state) => state.openSettings);
  const show = updateVisible(stage);
  return (
    <SidebarItem
      active={active}
      icon={<Settings />}
      title={appCopy.sidebar.settings}
      badge={!show ? undefined : stage === "downloading" ? `${PERCENT}%` : stage === "failed" ? "!" : "•"}
      ariaLabel={show ? `${appCopy.sidebar.settings} · ${label(stage, locale)}` : undefined}
      onClick={() => openSettings(show ? "updates" : "general")}
    />
  );
}

/** B · A progress ring first in the titlebar's trailing buttons. */
export function UpdateTitlebarRing({ stage, locale }: { stage: UpdateStage; locale: ProposalLocale }) {
  const openSettings = useButlerStore((state) => state.openSettings);
  if (!updateVisible(stage)) return null;
  const ratio = stage === "downloading" ? PERCENT / 100 : stage === "ready" || stage === "deferred" || stage === "activating" ? 1 : 0;
  const name = stage === "downloading" ? t(locale, "shell.update.ring", { percent: PERCENT }) : label(stage, locale);
  return (
    <Tooltip label={name}>
      <ContextDonutButton data-test-class="titlebar-update-ring" ratio={ratio} aria-label={name} onClick={() => openSettings("updates")} />
    </Tooltip>
  );
}
