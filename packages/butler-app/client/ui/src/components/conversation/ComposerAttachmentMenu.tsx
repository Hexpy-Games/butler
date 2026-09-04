import { useEffect, useRef } from "react";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { IconButton, Plus } from "@/butler-ds";
import { useComposerStore } from "./composerStore";

export const COMPOSER_DRAWER_ID = "composer-feature-drawer";

export function ComposerAttachmentMenu() {
  const activeChatId = useButlerStore((store) => store.activeChatId);
  const uploadingCount = useComposerStore((store) => store.uploadingCount);
  const open = useComposerStore((store) => store.featureDrawerOpen);
  const setOpen = useComposerStore((store) => store.setFeatureDrawerOpen);
  const setTriggerRef = useComposerStore(
    (store) => store.setAttachmentTriggerRef,
  );
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    setTriggerRef(triggerRef);
    return () => setTriggerRef(null);
  }, [setTriggerRef]);

  useEffect(() => {
    setOpen(false);
  }, [activeChatId, setOpen]);

  return (
    <IconButton
      ref={triggerRef}
      aria-controls={COMPOSER_DRAWER_ID}
      aria-expanded={open}
      data-test-class="attachment-button"
      disabled={uploadingCount > 0}
      label={appCopy.composer.featureDrawer}
      onClick={() => setOpen(!open)}
    >
      <Plus size={16} />
    </IconButton>
  );
}
