import { useEffect, useRef, useState } from "react";
import { apiErrorCode } from "@/app/api";
import { getButlerBackup, sendButlerBackup, type ButlerBackupStatus } from "@/app/butlerBackup";
import { confirmAction } from "@/app/confirmation";
import { appCopy } from "@/app/copy";
import { notifyStatus } from "@/app/notifications";
import { isMissingRoute } from "@/app/setupConnection";

export function useButlerBackup(accountId: string | undefined) {
  const [status, setStatus] = useState<ButlerBackupStatus | null>(null);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const acting = useRef(false);
  const copy = appCopy.butlerBackup;

  useEffect(() => {
    setStatus(null);
    setRecoveryKey(null);
    setRestoreOpen(false);
    setLoadFailed(false);
    if (!accountId) return;
    let cancelled = false;
    void sendButlerBackup("refresh").then((next) => {
      if (!cancelled) setStatus(next);
    }, (error: unknown) => {
      if (!cancelled && !isMissingRoute(error) && apiErrorCode(error) !== "butler_account_signed_out") setLoadFailed(true);
    });
    return () => { cancelled = true; };
  }, [accountId]);

  const polling = status?.state === "running" || status?.state === "restoring";
  useEffect(() => {
    if (!accountId || !polling || busy) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await getButlerBackup();
        if (!cancelled) setStatus(next);
      } finally {
        if (!cancelled) timer = setTimeout(() => void poll().catch(() => undefined), 1000);
      }
    }
    timer = setTimeout(() => void poll().catch(() => undefined), 1000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [accountId, busy, polling]);

  async function act(operation: () => Promise<void>, refresh = true) {
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    try {
      await operation();
      if (refresh) setStatus(await getButlerBackup());
    } catch (error) {
      const code = apiErrorCode(error);
      if (code === "recovery_key_invalid" || code === "recovery_key_wrong") return copy.keyWrong;
      notifyStatus(code === "restore_disk_full" ? copy.diskFull : copy.failedToast, { tone: "error" });
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }

  return {
    status, recoveryKey, restoreOpen, setRestoreOpen, busy, loadFailed,
    createKey: () => act(async () => setRecoveryKey((await sendButlerBackup("create_key")).recovery_key), false),
    cancel: () => act(async () => { await sendButlerBackup("cancel"); setRecoveryKey(null); }),
    start: () => act(async () => { await sendButlerBackup("start"); setRecoveryKey(null); }),
    backUpNow: () => act(async () => { await sendButlerBackup("back_up_now"); }),
    newKey: () => act(async () => {
      if (!await confirmAction(copy.newKeyConfirm, { title: copy.newKey, confirmLabel: copy.newKeyAction })) return;
      setRecoveryKey((await sendButlerBackup("new_key")).recovery_key);
    }, false),
    turnOff: () => act(async () => {
      if (await confirmAction(copy.offConfirm, { title: copy.turnOff, confirmLabel: copy.turnOff, destructive: true })) {
        await sendButlerBackup("turn_off");
      }
    }),
    restore: (key: string) => act(async () => {
      await sendButlerBackup("restore", { recovery_key: key });
      setRestoreOpen(false);
    }),
    restart: () => act(async () => { await sendButlerBackup("restart"); }, false),
  };
}
