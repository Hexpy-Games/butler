import { memo, useRef, useState, type MouseEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { ContextDonutButton, Popover, PopoverContent, PopoverTrigger } from "@/butler-ds";
import { useButlerStore } from "@/app/store.ts";
import { appShellTheme } from "@/app/utils.ts";
import { useComposerStore } from "./composerStore";
import { ContextUsagePopover } from "./ContextUsagePopover";
import { contextModel, usageAuthMode } from "./usageAuthMode";
import type { QuotaLoader, UsageLoader } from "./useConversationUsage";

/**
 * Composer context donut. Hover previews the context and usage popover; a
 * click (Enter/Space) pins it open until a second click, Esc or an outside
 * click. Details opens Settings > Usage.
 */
export const ComposerContextControl = memo(function ComposerContextControl({ load, loadQuota }: { load?: UsageLoader; loadQuota?: QuotaLoader }) {
  useAppLocale();
  const hasContext = useComposerStore((store) => Boolean(store.context));
  const ratio = useComposerStore((store) => store.context?.ratio ?? 0);
  const open = useComposerStore((store) => store.contextPopoverOpen);
  const setOpen = useComposerStore((store) => store.setContextPopoverOpen);
  const theme = useButlerStore(useShallow((store) => appShellTheme(store.settings)));
  const [pinned, setPinned] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  if (!hasContext) return null;

  const close = () => {
    setPinned(false);
    setOpen(false);
  };
  const togglePin = (event: MouseEvent<HTMLButtonElement>) => {
    // Radix would toggle the hover-opened popover closed; pinning owns the click.
    event.preventDefault();
    triggerRef.current = event.currentTarget;
    if (pinned) {
      close();
      return;
    }
    setPinned(true);
    setOpen(true);
  };
  return (
    <Popover open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <PopoverTrigger asChild>
        <ContextDonutButton
          data-test-class="context-donut-button"
          ratio={ratio}
          onClick={togglePin}
          onPointerEnter={() => setOpen(true)}
          onPointerLeave={() => {
            if (!pinned) setOpen(false);
          }}
          aria-label={appCopy.composer.contextDetails}
        />
      </PopoverTrigger>
      <PopoverContent
        data-test-class="context-popover"
        data-pinned={pinned ? "true" : undefined}
        align="center"
        theme={theme}
        side="top"
        sideOffset={10}
        width="narrow"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (pinned) triggerRef.current?.focus();
        }}
      >
        <ComposerUsageContent
          load={load}
          loadQuota={loadQuota}
          onClose={close}
        />
      </PopoverContent>
    </Popover>
  );
});

/** Full context refreshes the usage content; the closed ring subscribes only to its ratio. */
function ComposerUsageContent({ load, loadQuota, onClose }: { load?: UsageLoader; loadQuota?: QuotaLoader; onClose: () => void }) {
  const context = useComposerStore((store) => store.context);
  const models = useComposerStore((store) => store.models);
  const activeModel = useComposerStore((store) => store.activeModel);
  const activeChatId = useButlerStore((store) => store.activeChatId);
  const openSettings = useButlerStore((store) => store.openSettings);
  if (!context) return null;
  const mode = usageAuthMode(contextModel(models, context, activeModel), context);
  return <ContextUsagePopover context={context} load={load} loadQuota={loadQuota} mode={mode}
    sessionId={context.session_id ?? activeChatId} onDetails={() => { onClose(); openSettings("usage"); }} />;
}
