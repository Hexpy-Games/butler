import { useEffect, useRef } from "react";
import { appCopy } from "@/app/copy";
import { dismissNotification, notifyStatus } from "@/app/notifications";
import { useOrganization } from "@/app/space/organization";
import { useButlerStore } from "@/app/store";

const NOTICE_DURATION_MS = 8_000;

function currentSmartNotice() {
  const space = useButlerStore.getState().navigation.space;
  return space.smartNotice?.revision === space.revision ? space.smartNotice : undefined;
}

/** Only automatic grouping is announced; manual changes remain silent. */
export function useOrganizationNotice(): void {
  const revision = useButlerStore((s) => s.navigation.space.revision);
  const smartToken = useButlerStore((s) => s.navigation.space.smartNotice?.undoToken);
  const lastShown = useRef<string | null>(null);
  const activeId = useRef<string | null>(null);

  useEffect(() => {
    const notice = currentSmartNotice();
    const token = notice?.undoToken;
    const id = token ? `space-organization:${token}` : null;
    if (activeId.current && activeId.current !== id) {
      dismissNotification(activeId.current);
      activeId.current = null;
    }
    if (!notice || !token) {
      return;
    }
    if (lastShown.current === token) return;
    lastShown.current = token;
    activeId.current = id;
    notifyStatus(appCopy.space.organized(notice.title), {
      id: id!,
      duration: NOTICE_DURATION_MS,
      action: {
        label: appCopy.space.undo,
        onClick: (event) => {
          if (useOrganization.getState().pending) {
            event.preventDefault();
            return;
          }
          if (currentSmartNotice()?.undoToken === token) {
            void useOrganization.getState().mutate({ action: "undo", undoToken: token });
          }
        },
      },
    });
  }, [revision, smartToken]);
}
