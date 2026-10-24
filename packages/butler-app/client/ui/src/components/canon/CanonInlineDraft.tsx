import { createContext, useContext, useState, type ReactNode, type Dispatch, type SetStateAction } from "react";
import type { MessageFileRef } from "@/app/types.ts";
import type { EpicDetail } from "@/app/canonApi.ts";

export type EpicTextField = "title" | "description";
export type InlineDraft = { field: EpicTextField; value: string; base: EpicDetail; revision: number; current?: EpicDetail };
type DraftState = [InlineDraft | null, Dispatch<SetStateAction<InlineDraft | null>>];
type UploadState = { pendingFile: File | null; files: MessageFileRef[] };
const UploadContext = createContext<[UploadState, Dispatch<SetStateAction<UploadState>>] | null>(null);
const DraftContext = createContext<DraftState | null>(null);

/** ConversationShell remounts its aside on a layout flip; the conversation keeps the draft. */
export function CanonInlineDraftProvider({ children }: { children: ReactNode }) {
  const parent = useContext(DraftContext);
  const state = useState<InlineDraft | null>(null);
  const uploads = useState<UploadState>({ pendingFile: null, files: [] });
  if (parent) return children;
  return <DraftContext.Provider value={state}><UploadContext.Provider value={uploads}>{children}</UploadContext.Provider></DraftContext.Provider>;
}

export function useCanonInlineDraft(): DraftState {
  const shared = useContext(DraftContext);
  const local = useState<InlineDraft | null>(null);
  return shared ?? local;
}

export function useCanonInlineUploads() {
  const shared = useContext(UploadContext);
  const local = useState<UploadState>({ pendingFile: null, files: [] });
  return shared ?? local;
}
