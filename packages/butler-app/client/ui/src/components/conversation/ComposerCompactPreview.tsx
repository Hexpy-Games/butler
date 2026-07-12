import { appCopy } from "@/app/copy.ts";
import { ComposerCardCompactPreview } from "@/butler-ds";
import { useComposerStore } from "./composerStore";

export function ComposerCompactPreview() {
  const large = useComposerStore((store) => store.large);
  const setEngaged = useComposerStore((store) => store.setEngaged);
  const text = useComposerStore((store) => store.text);
  const textAreaRef = useComposerStore((store) => store.textAreaRef);
  const preview = text.trim() ||
    (large
      ? appCopy.composer.placeholder
      : appCopy.composer.placeholderFollowUp);
  const engage = () => {
    setEngaged(true);
    window.requestAnimationFrame(() => {
      textAreaRef?.current?.focus({ preventScroll: true });
    });
  };

  return (
    <ComposerCardCompactPreview
      aria-label={appCopy.composer.messageComposer}
      data-empty={!text.trim()}
      onPointerDown={(event) => {
        event.preventDefault();
        engage();
      }}
      onClick={engage}
    >
      {preview}
    </ComposerCardCompactPreview>
  );
}
