import { useCallback, useEffect, useState } from "react";
import { apiErrorCode } from "@/app/api.ts";
import type { CanonOnlineAction, CanonSpaceMembers } from "@/app/canonApi.ts";
import { postCanonOnline, useCanonOnlineLink, useCanonOnlineStore } from "@/app/canonOnline.ts";
import { confirmAction } from "@/app/confirmation.ts";
import { appCopy } from "@/app/copy.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import { useButlerStore } from "@/app/store.ts";
import { useCanonOnlineAccount } from "./useCanonOnlineAccount.ts";

export function useCanonOnlineDialog(projectId: string, onClose: () => void) {
  const account = useCanonOnlineAccount();
  const { state, setSignedOut } = account;
  const link = useCanonOnlineLink(projectId);
  const linked = link?.state === "linked";
  const [members, setMembers] = useState<CanonSpaceMembers>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<string>();
  const copy = appCopy.canon.online;
  const reload = useCallback(async () => {
    setLoadFailed(false);
    try {
      setMembers(await postCanonOnline<CanonSpaceMembers>({ action: "members", project_id: projectId }));
    } catch (error) {
      if (apiErrorCode(error) === "butler_account_signed_out") setSignedOut();
      else {
        setLoadFailed(true);
        notifyError(error, appCopy.butlerAccount.failed);
      }
    }
  }, [projectId, setSignedOut]);
  useEffect(() => {
    if (state === "in" && linked) void reload();
  }, [linked, reload, state]);

  const run = async (action: CanonOnlineAction, busyKey: string, message?: string, onSuccess?: () => void) => {
    setBusy(busyKey);
    try {
      await postCanonOnline(action);
      const refreshStatus = action.action === "link" || action.action === "unlink" || action.action === "leave";
      if (refreshStatus) await useCanonOnlineStore.getState().refresh();
      onSuccess?.();
      if (message) notifyStatus(message, { tone: "ok" });
      if (!refreshStatus) await reload();
      if (action.action === "leave") onClose();
    } catch (error) {
      if (apiErrorCode(error) === "butler_account_signed_out") setSignedOut();
      else notifyError(error, appCopy.butlerAccount.failed);
    } finally {
      setBusy(undefined);
    }
  };
  const project_id = projectId;
  return {
    account, link, members, loadFailed, busy, reload,
    linkProject: () => {
      const name = useButlerStore.getState().navigation.projects.find(project => project.id === projectId)!.display_name;
      return run({ action: "link", project_id, name }, "link", copy.linked);
    },
    unlink: async () => {
      if (linked && !await confirmAction(copy.turnOffConfirm, { title: copy.turnOffTitle, confirmLabel: copy.turnOff, destructive: true })) return;
      await run({ action: "unlink", project_id }, "unlink", copy.unlinked);
    },
    invite: (email: string, role: "editor" | "viewer", onSuccess: () => void) =>
      run({ action: "invite", project_id, email, role }, "invite", copy.inviteSent(email), onSuccess),
    revoke: (invite_id: string) => run({ action: "revoke_invite", project_id, invite_id }, invite_id),
    setRole: (account_id: string, role: "editor" | "viewer") => run({ action: "set_role", project_id, account_id, role }, "set_role"),
    remove: async (account_id: string, email: string) => {
      if (!await confirmAction(copy.removeConfirm(email), { title: copy.remove, confirmLabel: copy.remove, destructive: true })) return;
      await run({ action: "remove_member", project_id, account_id }, account_id, copy.removed);
    },
    leave: async () => {
      if (!await confirmAction(copy.leaveConfirm, { title: copy.leave, confirmLabel: copy.leave, destructive: true })) return;
      await run({ action: "leave", project_id }, "leave", copy.left);
    },
  };
}
