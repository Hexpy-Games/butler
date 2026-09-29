import { TitlebarShell } from "../../../../blocks/TitlebarShell";
import { ButtonContainer } from "../../../ButtonContainer";
import { IconButton } from "../../../IconButton";
import { IconSlot } from "../../../IconSlot";
import { GitBranch, MoreHorizontal, PanelRight } from "../../../Icons";
import { Stack } from "../../../Stack";
import { Typo } from "../../../Typo";
import type { LayoutCopy } from "./layoutCopy";

/** The session titlebar (Titlebar): title, project and workspace, the session menu and the inspector toggle. */
export function Titlebar({ copy, collapsed }: { copy: LayoutCopy; collapsed: boolean }) {
  return (
    <TitlebarShell
      collapsed={collapsed}
      dataTestClass="custom-titlebar"
      dragRegion
      subtitle={
        <Stack as="span" inline align="row" cross="center" gap="sm" minWidth="0">
          <Typo.Text grow minWidth="0" truncate>{copy.project}</Typo.Text>
          <Stack as="span" inline align="row" cross="center" gap="xs" minWidth="0">
            <IconSlot size="xs" tone="secondary"><GitBranch size="xs" aria-hidden="true" /></IconSlot>
            <Typo.Text truncate>{copy.local}</Typo.Text>
          </Stack>
        </Stack>
      }
      title={copy.sessions[copy.active]}
      trailing={
        <ButtonContainer size="icon-sm">
          <IconButton label={copy.more}><MoreHorizontal size="md" /></IconButton>
          <IconButton label={copy.panel}><PanelRight size="md" /></IconButton>
        </ButtonContainer>
      }
    />
  );
}
