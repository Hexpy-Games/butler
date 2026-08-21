import type { SessionSummaryView } from "@/app/types.ts";
import { GitDependencyNotice } from "./GitDependencyNotice";
import { StewardComposerCapsules } from "./StewardComposerCapsules.tsx";

export function ComposerNotices({
  summary,
}: {
  summary?: SessionSummaryView | null;
}) {
  return (
    <>
      <StewardComposerCapsules
        children={summary?.steward_children ?? []}
        synthesis={summary?.latest_turn_subsession_result}
      />
      <GitDependencyNotice />
    </>
  );
}
