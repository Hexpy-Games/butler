import { useEffect, useRef } from "react";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { appThemeClasses } from "@/app/utils.ts";
import {
  ListChecks,
  MessageSquarePlus,
  OptionMenu,
  OptionMenuItem,
  OptionMenuSection,
  Paperclip,
} from "@/butler-ds";
import { COMPOSER_DRAWER_ID } from "./ComposerAttachmentMenu";
import { ComposerProjectDocumentMenu } from "./ComposerProjectDocumentMenu";
import { activeProjectId } from "./composerProjectContext";
import { useComposerStore } from "./composerStore";
import styles from "./ComposerAttachmentDrawer.module.css";

export function ComposerAttachmentDrawer() {
  const activeChatId = useButlerStore((state) => state.activeChatId);
  const navigation = useButlerStore((state) => state.navigation);
  const settings = useButlerStore((state) => state.settings);
  const open = useComposerStore((store) => store.featureDrawerOpen);
  const setOpen = useComposerStore((store) => store.setFeatureDrawerOpen);
  const triggerRef = useComposerStore((store) => store.attachmentTriggerRef);
  const planMode = useComposerStore((store) => store.planMode);
  const setPlanMode = useComposerStore((store) => store.handlePlanModeChange);
  const openFilePicker = useComposerStore(
    (store) => store.openAttachmentPicker,
  );
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const projectId = activeProjectId(navigation, activeChatId);

  useEffect(() => {
    if (!open) return;
    drawerRef.current
      ?.querySelector<HTMLButtonElement>(
        '[data-slot="option-menu-item"]:not(:disabled)',
      )
      ?.focus();
  }, [open]);

  if (!open) return null;
  const close = () => setOpen(false);
  return (
    <div
      ref={drawerRef}
      id={COMPOSER_DRAWER_ID}
      data-test-class="composer-feature-drawer"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        close();
        triggerRef?.current?.focus();
      }}
    >
      <OptionMenu
        className={styles.menu}
        title={appCopy.composer.featureDrawer}
      >
        <OptionMenuSection title={appCopy.composer.attachments}>
          {projectId ? (
            <ComposerProjectDocumentMenu
              className={appThemeClasses(settings)}
              onClose={close}
              projectId={projectId}
            />
          ) : null}
          <OptionMenuItem
            icon={<Paperclip size={15} />}
            label={appCopy.composer.attachFile}
            onClick={() => {
              openFilePicker();
              close();
            }}
          />
        </OptionMenuSection>
        <OptionMenuSection title={appCopy.composer.responseMode}>
          <OptionMenuItem
            icon={<MessageSquarePlus size={15} />}
            label={appCopy.composer.normal}
            selected={!planMode}
            onClick={() => {
              setPlanMode(false);
              close();
            }}
          />
          {projectId ? (
            <OptionMenuItem
              icon={<ListChecks size={15} />}
              label={appCopy.composer.plan}
              selected={planMode}
              onClick={() => {
                setPlanMode(true);
                close();
              }}
            />
          ) : null}
        </OptionMenuSection>
      </OptionMenu>
    </div>
  );
}
