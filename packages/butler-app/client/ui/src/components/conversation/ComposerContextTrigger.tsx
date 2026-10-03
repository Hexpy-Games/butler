import { memo, type MouseEventHandler } from "react";
import { ContextDonutButton, PopoverTrigger } from "@/butler-ds";

/** The ring depends on the displayed ratio, not changes to the usage detail projection. */
export const ComposerContextTrigger = memo(function ComposerContextTrigger({ ratio, label, onClick, onEnter, onLeave }: {
  ratio: number; label: string; onClick: MouseEventHandler<HTMLButtonElement>;
  onEnter: () => void; onLeave: () => void;
}) {
  return <PopoverTrigger asChild><ContextDonutButton data-test-class="context-donut-button" ratio={ratio}
    onClick={onClick} onPointerEnter={onEnter} onPointerLeave={onLeave} aria-label={label} /></PopoverTrigger>;
});
