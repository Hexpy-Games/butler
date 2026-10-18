import { api } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import { libraryChanged } from "@/app/libraryEvents.ts";
import { notifyStatus } from "@/app/notifications.ts";
import { useButlerStore } from "@/app/store.ts";

/** Saves a file the turn made to the Library; the reply then lists it with its deliverables. */
export async function addWorkingFileToLibrary(fileId: string): Promise<void> {
  try {
    await api("/library/documents", { method: "POST", body: JSON.stringify({ file_id: fileId }) });
  } catch {
    notifyStatus(appCopy.library.failed, { tone: "error" });
    return;
  }
  libraryChanged();
  notifyStatus(appCopy.conversation.answerBlocks.savedToLibrary);
  await useButlerStore.getState().refreshSessionView();
}
