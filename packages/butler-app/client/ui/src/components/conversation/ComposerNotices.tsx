import type { StewardSessionSummaryView } from "@/app/types.ts";
import { GitDependencyNotice } from "./GitDependencyNotice";
import { StewardComposerCapsules } from "./StewardComposerCapsules.tsx";

export function ComposerNotices({
  stewardChildren,
}: {
  stewardChildren: StewardSessionSummaryView[];
}) {
  return (
    <>
      <StewardComposerCapsules children={stewardChildren} />
      <GitDependencyNotice />
    </>
  );
}
