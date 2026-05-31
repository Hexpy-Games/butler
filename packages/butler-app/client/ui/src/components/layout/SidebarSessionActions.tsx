import {
  Archive,
  PencilLine,
  ButtonContainer,
  OverflowActionMenu,
} from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { SessionSummary } from "@/app/types.ts";

export type SessionAction = "rename" | "archive";

interface SidebarSessionActionsProps {
  menuOpen: boolean;
  onRunAction: (session: SessionSummary, action: SessionAction) => void;
  session: SessionSummary;
  setMenuOpen: (open: boolean) => void;
}

export function SidebarSessionActions({
  menuOpen,
  onRunAction,
  session,
  setMenuOpen,
}: SidebarSessionActionsProps) {
  return (
    <ButtonContainer
      className="no-drag"
      size="icon-sm"
      onClick={(event) => event.stopPropagation()}
    >
      <OverflowActionMenu
        label={appCopy.sessionActions.menuLabel}
        open={menuOpen}
        onOpenChange={setMenuOpen}
        items={[
          {
            icon: <PencilLine size={14} />,
            label: appCopy.sessionActions.rename,
            onSelect: () => onRunAction(session, "rename"),
          },
          {
            icon: <Archive size={14} />,
            label: appCopy.sessionActions.archive,
            onSelect: () => onRunAction(session, "archive"),
          },
        ]}
      />
    </ButtonContainer>
  );
}
