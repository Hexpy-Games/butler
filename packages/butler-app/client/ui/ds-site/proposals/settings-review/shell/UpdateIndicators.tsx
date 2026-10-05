import { useAppLocale } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import { Button, CircleAlert, IconSlot, NavRow, Spinner } from "@/butler-ds";
import { t } from "../proposedCopy";
import type { ProposalLocale, UpdateStage } from "../state";
import { UPDATE_BYTES } from "../updates/updateFixture";

// NEW: the update row above 설정 in the sidebar footer. One NavRow line: ring, label, percent
// (badge slot) or 다시 시작 (actions slot). Renders only while an update is running, ready or
// failed; tapping the row opens Settings › 업데이트.

const PERCENT = Math.floor((UPDATE_BYTES.done / UPDATE_BYTES.total) * 100);

export function updateVisible(stage: UpdateStage): boolean {
  return !["available", "upToDate"].includes(stage);
}

/**
 * STAND-IN for the missing DS `ProgressRing` (see DS gaps): ContextDonutButton's ring, same
 * geometry (r 8 in a 20 box, 3.5 stroke, round cap, track --context-track-bg, fill --accent),
 * without its 30px button, sized by IconSlot `sidebar` like every sidebar icon.
 */
function RingStandIn({ value }: { value: number }) {
  const circumference = 2 * Math.PI * 8;
  return (
    <IconSlot size="sidebar">
      <svg viewBox="0 0 20 20" width="100%" height="100%" transform="rotate(-90)" aria-hidden="true">
        <circle cx="10" cy="10" r="8" fill="none" strokeWidth="3.5" stroke="var(--context-track-bg)" />
        <circle cx="10" cy="10" r="8" fill="none" strokeWidth="3.5" stroke="var(--accent)" strokeLinecap="round"
          strokeDasharray={circumference} strokeDashoffset={circumference * (1 - value / 100)} />
      </svg>
    </IconSlot>
  );
}

function rowLabel(stage: UpdateStage, locale: ProposalLocale): string {
  if (stage === "downloading" || stage === "downloadingUnknown") return t(locale, "shell.update.downloading");
  if (stage === "ready" || stage === "deferred") return t(locale, "shell.update.ready");
  if (stage === "failed") return t(locale, "shell.update.failed");
  return t(locale, "shell.update.working");
}

export function UpdateSidebarRow({ stage, locale }: { stage: UpdateStage; locale: ProposalLocale }) {
  useAppLocale();
  const openSettings = useButlerStore((state) => state.openSettings);
  if (!updateVisible(stage)) return null;
  const icon = stage === "failed" ? <CircleAlert />
    : stage === "downloading" ? <RingStandIn value={PERCENT} />
    : stage === "ready" || stage === "deferred" ? <RingStandIn value={100} />
    : <IconSlot size="sidebar"><Spinner size={14} /></IconSlot>;
  const label = rowLabel(stage, locale);
  return (
    <NavRow
      dataTestClass="sidebar-update-row"
      icon={icon}
      label={label}
      ariaLabel={stage === "downloading" ? `${label} ${PERCENT}%` : label}
      badge={stage === "downloading" ? `${PERCENT}%` : undefined}
      actions={stage === "ready" ? (
        <Button type="button" size="xs" variant="outline" onClick={(event) => event.stopPropagation()}>
          {t(locale, "settings.updateProgress.restart")}
        </Button>
      ) : undefined}
      onClick={() => openSettings("updates")}
    />
  );
}
