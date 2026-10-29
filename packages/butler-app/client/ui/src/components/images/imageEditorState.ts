import { create } from "zustand";
import type { ImageAsset } from "./imageApi";
import { closeImageViewer } from "../media/imageViewerState";

interface EditorTarget { session: string; asset: ImageAsset; selected?: ImageAsset }
export const useImageEditorState = create<{ target?: EditorTarget }>(() => ({}));
let returnFocus: HTMLElement | null = null;
export function openImageEditor(session: string, asset: ImageAsset) {
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  closeImageViewer();
  useImageEditorState.setState({ target: { session, asset } });
}
export function closeImageEditor() {
  useImageEditorState.setState({ target: undefined });
  requestAnimationFrame(() => { if (returnFocus?.isConnected) returnFocus.focus(); returnFocus = null; });
}

export function selectImageEditorVersion(selected: ImageAsset) {
  useImageEditorState.setState(s => s.target ? { target: { ...s.target, selected } } : {});
}
