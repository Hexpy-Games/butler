import { appCopy } from "@/app/copy.ts";
import type { ComposerModelState } from "@/app/types.ts";

export function composerModelStateLabel(state: ComposerModelState): string {
  if (state === "loading") return appCopy.composer.modelLoading;
  if (state === "error") return appCopy.composer.modelError;
  return appCopy.composer.modelUnavailable;
}
