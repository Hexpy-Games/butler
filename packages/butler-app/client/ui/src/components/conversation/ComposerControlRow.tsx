import { memo } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { Box, ButtonContainer, ScrollArea } from "@/butler-ds";
import { AccessModeMenu } from "./AccessModeMenu";
import { ComposerAttachmentMenu } from "./ComposerAttachmentMenu";
import { ComposerContextControl } from "./ComposerContextControl";
import { ComposerPlanModeBadge } from "./ComposerPlanModeBadge";
import { ComposerWorkspaceSelect } from "./ComposerWorkspaceSelect";
import { ModelMenu } from "./ModelMenu";

export const ComposerControlRow = memo(function ComposerControlRow() {
  useAppLocale();
  return (
    <ScrollArea orientation="x" flush dataSlot="composer-controls" dataTestClass="composer-controls">
      <ButtonContainer size="sm" wrap={false} grow role="group" aria-label={appCopy.composer.controls}>
        <ComposerAttachmentMenu />
        <AccessModeMenu />
        <ComposerWorkspaceSelect />
        <ComposerPlanModeBadge />
        <Box grow aria-hidden="true" />
        <ComposerContextControl />
        <ModelMenu />
      </ButtonContainer>
    </ScrollArea>
  );
});
