import { create } from "zustand";
import { api } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import { libraryChanged } from "@/app/libraryEvents.ts";
import { notifyStatus } from "@/app/notifications.ts";
import { useButlerStore } from "@/app/store.ts";
import { answerActionFailed } from "./answerBlockActions";

/** The file just saved to the Library; its reply focuses the file's new deliverable row once it is listed. */
export const usePromotedFile = create<{ fileId?: string }>(() => ({}));

/** Saves a file the turn made to the Library; the reply then lists it with its deliverables. */
export async function addWorkingFileToLibrary(fileId: string): Promise<void> {
  try {
    await api("/library/documents", { method: "POST", body: JSON.stringify({ file_id: fileId }) });
  } catch (error) {
    answerActionFailed(error);
    return;
  }
  libraryChanged();
  notifyStatus(appCopy.conversation.answerBlocks.savedToLibrary);
  usePromotedFile.setState({ fileId });
  // A snapshot re-reads the loaded messages, so the row moves into the deliverables.
  const refreshed = await useButlerStore.getState().refreshSessionView(undefined, { snapshot: true });
  if (!refreshed) usePromotedFile.setState({ fileId: undefined });
}
