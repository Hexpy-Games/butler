import { useAppLocale } from "@/app/copy.ts";
import { ContextDonutButton, Popover, PopoverContent, PopoverTrigger } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { appThemeClasses } from "@/app/utils.ts";
import { useComposerStore } from "./composerStore";
import { ContextUsagePopover } from "./ContextUsagePopover";

export function ComposerContextControl() {
  useAppLocale();
  const context = useComposerStore((store) => store.context);
  const open = useComposerStore((store) => store.contextPopoverOpen);
  const setOpen = useComposerStore((store) => store.setContextPopoverOpen);
  const onOpenContext = useComposerStore((store) => store.onOpenContext);
  const settings = useButlerStore((store) => store.settings);

  if (!context) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <ContextDonutButton
          data-test-class="context-donut-button"
          ratio={context.ratio ?? 0}
          onBlur={() => setOpen(false)}
          onClick={onOpenContext}
          onFocus={() => setOpen(true)}
          onPointerEnter={() => setOpen(true)}
          onPointerLeave={() => setOpen(false)}
          aria-label={appCopy.composer.contextDetails}
        />
      </PopoverTrigger>
      <PopoverContent
        data-test-class="context-popover"
        align="center"
        className={appThemeClasses(settings)}
        side="top"
        sideOffset={10}
      >
        <ContextUsagePopover context={context} />
      </PopoverContent>
    </Popover>
  );
}
