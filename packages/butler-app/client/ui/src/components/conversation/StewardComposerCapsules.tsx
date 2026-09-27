import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import type { StewardSessionSummaryView } from "@/app/types.ts";
import type { ReactNode } from "react";
import { useButlerStore } from "@/app/store.ts";
import { ButlerThinkingMark, PillButton, Stack, StatusCapsule } from "@/butler-ds";
import {
  activeStewardChildren,
  stewardCurrentActivityTitle,
  stewardPlanProgress,
} from "./stewardProgressPresentation.ts";
import { useButlerMarkTheme } from "./hooks/useButlerMarkTheme.ts";

type SynthesisContext = {
  relation_id: string;
  result_id: string;
  safe_title: string;
};

export function StewardComposerCapsules({
  children,
  synthesis,
}: {
  children: StewardSessionSummaryView[];
  synthesis?: SynthesisContext;
}) {
  useAppLocale();
  const markTheme = useButlerMarkTheme();
  const openSessionObserver = useButlerStore(
    (state) => state.openSessionObserver,
  );
  const activeChildren = activeStewardChildren(children);
  const synthesisChild = synthesis
    ? children.find((child) => child.relation.relation_id === synthesis.relation_id)
    : undefined;
  if (activeChildren.length === 0 && !synthesis) return null;

  const mark = (
    <ButlerThinkingMark
      state="working"
      size="sm"
      theme={markTheme}
    />
  );

  return (
    <Stack
      align="row"
      aria-label={appCopy.interfaceDetails.activeWork}
      data-test-class="steward-composer-capsules"
      data-alignment="center"
      gap="xs"
      justify="center"
      wrap
    >
      {synthesis ? (
        <PillButton
          aria-label={appCopy.interfaceTemplates.reportPreparing(synthesis.safe_title)}
          data-truncation="ellipsis"
          data-test-class="steward-synthesis-capsule"
          disabled={!synthesisChild}
          icon={mark}
          onClick={() => synthesisChild && openSessionObserver(synthesisChild.session_id)}
          title={synthesis.safe_title}
          type="button"
          surface="glass"
        >
          {appCopy.interfaceTemplates.reportPreparing(synthesis.safe_title)}
        </PillButton>
      ) : null}
      {activeChildren.map((child) => (
        <StewardProgressCapsule
          child={child}
          key={child.session_id}
          mark={mark}
          onOpen={() => openSessionObserver(child.session_id)}
        />
      ))}
    </Stack>
  );
}

function StewardProgressCapsule({
  child,
  mark,
  onOpen,
}: {
  child: StewardSessionSummaryView;
  mark: ReactNode;
  onOpen: () => void;
}) {
  useAppLocale();
  const taskTitle = child.title.trim().replace(/\s+/gu, " ") || appCopy.interfaceDetails.activeWork;
  const activityTitle = stewardCurrentActivityTitle(child);
  const progress = stewardPlanProgress(child);
  return (
    <StatusCapsule
      aria-label={appCopy.interfaceTemplates.progressDetails(taskTitle, activityTitle, progress)}
      data-test-class="steward-progress-capsule"
      icon={mark}
      onClick={onOpen}
      title={taskTitle}
      detail={activityTitle}
      progress={progress || undefined}
      partTestClasses={{
        title: "steward-capsule-task",
        detail: "steward-capsule-activity",
        progress: "steward-capsule-progress",
      }}
    />
  );
}
