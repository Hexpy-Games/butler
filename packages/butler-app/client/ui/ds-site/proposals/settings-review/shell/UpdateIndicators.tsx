import { useAppLocale } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import { ButtonContainer, CircleAlert, IconButton, NavRow, ProgressRing, RotateCcw } from "@/butler-ds";
import { t } from "../proposedCopy";
import type { ProposalLocale, UpdateStage } from "../state";
import { UPDATE_BYTES } from "../updates/updateFixture";

// NEW: the update row above 설정 in the sidebar footer. One NavRow line at rest style (never
// `active`): ProgressRing, label, percent (badge slot) or 다시 시작 (actions slot). Renders only
// while an update is running, ready or failed; tapping the row opens Settings › 업데이트.

const FRACTION = UPDATE_BYTES.done / UPDATE_BYTES.total;
const PERCENT = Math.floor(FRACTION * 100);

export function updateVisible(stage: UpdateStage): boolean {
  return !["available", "upToDate"].includes(stage);
}

function rowLabel(stage: UpdateStage, locale: ProposalLocale): string {
  if (stage === "downloading" || stage === "downloadingUnknown") return t(locale, "shell.update.downloading");
  if (stage === "ready" || stage === "deferred") return t(locale, "shell.update.ready");
  if (stage === "failed") return t(locale, "shell.update.failed");
  return t(locale, "shell.update.working");
}

/** The row glyph: a ring sized and weighted like the sidebar icons (size="sidebar"), decorative. */
function rowIcon(stage: UpdateStage) {
  if (stage === "failed") return <CircleAlert />;
  if (stage === "downloading") return <ProgressRing size="sidebar" value={FRACTION} aria-hidden />;
  if (stage === "ready" || stage === "deferred") return <ProgressRing size="sidebar" value={1} tone="success" aria-hidden />;
  return <ProgressRing size="sidebar" indeterminate aria-hidden />;
}

export function UpdateSidebarRow({ stage, locale }: { stage: UpdateStage; locale: ProposalLocale }) {
  useAppLocale();
  const openSettings = useButlerStore((state) => state.openSettings);
  if (!updateVisible(stage)) return null;
  const label = rowLabel(stage, locale);
  return (
    <NavRow
      dataTestClass="sidebar-update-row"
      icon={rowIcon(stage)}
      label={label}
      ariaLabel={stage === "downloading" ? `${label} ${PERCENT}%` : label}
      badge={stage === "downloading" ? `${PERCENT}%` : undefined}
      // The DS-defined NavRow action (as SpaceRowActions / SidebarChatsSection): ButtonContainer
      // size="icon-sm" + IconButton (ghost, icon-sm, tooltip = label), stopping propagation. The DS
      // defines no text button in a NavRow; see the gap in the spec.
      actions={stage === "ready" ? (
        <ButtonContainer size="icon-sm" wrap={false}
          onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
          <IconButton label={t(locale, "settings.updateProgress.restart")} data-test-class="sidebar-update-restart">
            <RotateCcw />
          </IconButton>
        </ButtonContainer>
      ) : undefined}
      onClick={() => openSettings("updates")}
    />
  );
}
