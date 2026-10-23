import { apiErrorCode } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
/** Writes never retry. Conflicts reload both board and selected detail. */
export async function canonWriteFailure(error: unknown, refresh: () => Promise<void>): Promise<void> {
  const code = apiErrorCode(error);
  if (code === "conflict" || code === "running") {
    notifyStatus(code === "conflict" ? appCopy.canon.conflict : appCopy.canon.running, { tone: "error" });
    await refresh();
  } else notifyError(error, appCopy.interfaceFeedback.requestFailed);
}
