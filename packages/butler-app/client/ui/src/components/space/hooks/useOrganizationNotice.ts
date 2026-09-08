import { useEffect, useRef } from "react";
import { appCopy } from "@/app/copy";
import { dismissNotification, notifyStatus } from "@/app/notifications";
import { useOrganization } from "@/app/space/organization";
import { useButlerStore } from "@/app/store";

const NOTICE_DURATION_MS = 8_000;

function currentUndoToken(): string | null {
  const space = useButlerStore.getState().navigation.space;
  const organization = useOrganization.getState();
  if (space.smartNotice?.revision === space.revision) return space.smartNotice.undoToken;
  return organization.undoRevision === space.revision ? organization.undoToken : null;
}

/** Projects the current reversible change without reserving sidebar layout space. */
export function useOrganizationNotice(): void {
  const revision = useButlerStore((s) => s.navigation.space.revision);
  const smartToken = useButlerStore((s) => s.navigation.space.smartNotice?.undoToken);
  const undoToken = useOrganization((s) => s.undoToken);
  const undoRevision = useOrganization((s) => s.undoRevision);
  const lastShown = useRef<string | null>(null);
  const activeId = useRef<string | null>(null);

  useEffect(() => {
    const token = currentUndoToken();
    const id = token ? `space-organization:${token}` : null;
    if (activeId.current && activeId.current !== id) {
      dismissNotification(activeId.current);
      activeId.current = null;
    }
    if (!token) {
      return;
    }
    if (lastShown.current === token) return;
    lastShown.current = token;
    activeId.current = id;
    const notice = useButlerStore.getState().navigation.space.smartNotice;
    notifyStatus(notice?.undoToken === token
      ? appCopy.space.organized(notice.title)
      : appCopy.space.organizationUpdated, {
      id: id!,
      duration: NOTICE_DURATION_MS,
      action: {
        label: appCopy.space.undo,
        onClick: (event) => {
          if (useOrganization.getState().pending) {
            event.preventDefault();
            return;
          }
          if (currentUndoToken() === token) {
            void useOrganization.getState().mutate({ action: "undo", undoToken: token });
          }
        },
      },
    });
  }, [revision, smartToken, undoToken, undoRevision]);
}
