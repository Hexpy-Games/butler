import { useCallback, useLayoutEffect } from "react";
import type { ChangeEvent } from "react";
import { appCopy } from "@/app/copy.ts";
import { useComposerStore } from "./composerStore";
import { ComposerCardTextarea } from "@/butler-ds";

export const COMPOSER_MAX_AUTO_ROWS = 8;

function numericCssValue(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function resizeComposerTextArea(element: HTMLTextAreaElement) {
  const style = window.getComputedStyle(element);
  const lineHeight = numericCssValue(style.lineHeight) || 20;
  const verticalPadding =
    numericCssValue(style.paddingTop) + numericCssValue(style.paddingBottom);
  const verticalBorder =
    numericCssValue(style.borderTopWidth) +
    numericCssValue(style.borderBottomWidth);
  const maxHeight =
    lineHeight * COMPOSER_MAX_AUTO_ROWS + verticalPadding + verticalBorder;

  element.style.height = "auto";
  const nextHeight = Math.min(element.scrollHeight, maxHeight);
  element.style.height = `${nextHeight}px`;
  element.style.overflowY = element.scrollHeight > maxHeight ? "auto" : "hidden";
}

export function ComposerTextArea() {
  const text = useComposerStore((store) => store.text);
  const setText = useComposerStore((store) => store.setText);
  const setIsComposing = useComposerStore((store) => store.setIsComposing);
  const handleKeyDown = useComposerStore((store) => store.handleKeyDown);
  const large = useComposerStore((store) => store.large);
  const textAreaRef = useComposerStore((store) => store.textAreaRef);
  const minRows = large ? 3 : 2;
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      setText(event.target.value);
      resizeComposerTextArea(event.target);
    },
    [setText],
  );

  useLayoutEffect(() => {
    const element = textAreaRef?.current;
    if (element) resizeComposerTextArea(element);
  }, [large, text, textAreaRef]);

  return (
    <ComposerCardTextarea
      ref={textAreaRef}
      aria-label={appCopy.composer.messageComposer}
      value={text}
      data-max-auto-rows={COMPOSER_MAX_AUTO_ROWS}
      onChange={handleChange}
      onCompositionStart={() => setIsComposing(true)}
      onCompositionEnd={() => setIsComposing(false)}
      onKeyDown={handleKeyDown}
      placeholder={
        large
          ? appCopy.composer.placeholder
          : appCopy.composer.placeholderFollowUp
      }
      rows={minRows}
    />
  );
}
