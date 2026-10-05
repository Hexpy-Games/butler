import { memo, useLayoutEffect, useRef, useState } from "react";
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const updateOverflow = () => {
      const next = scroll.scrollWidth > scroll.clientWidth;
      setOverflows(current => current === next ? current : next);
    };
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(scroll);
    if (scroll.firstElementChild) observer.observe(scroll.firstElementChild);
    updateOverflow();
    return () => observer.disconnect();
  }, []);
  return (
    <ScrollArea scrollRef={scrollRef} orientation="x" flush dataSlot="composer-controls" dataTestClass="composer-controls">
      <ButtonContainer size="sm" wrap={false} grow role="group" aria-label={appCopy.composer.controls}>
        <ComposerAttachmentMenu />
        <AccessModeMenu />
        <ComposerWorkspaceSelect />
        <ComposerPlanModeBadge />
        {overflows ? null : <Box grow basis="0" minWidth="0" aria-hidden="true" />}
        <ComposerContextControl />
        <ModelMenu />
      </ButtonContainer>
    </ScrollArea>
  );
});
