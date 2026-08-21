import type { StewardSessionSummaryView } from "@/app/types.ts";
import type { ReactNode } from "react";
import { useButlerStore } from "@/app/store.ts";
import { Button, Stack } from "@/butler-ds";
import { ButlerThinkingMark } from "@/components/common/ButlerThinkingMark.tsx";
import {
  activeStewardChildren,
  stewardCurrentActivityTitle,
  stewardPlanProgress,
} from "./stewardProgressPresentation.ts";
import { useButlerMarkTheme } from "./hooks/useButlerMarkTheme.ts";
import styles from "./StewardComposerCapsules.module.css";

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
      style={{ height: 14, width: 14 }}
      theme={markTheme}
    />
  );

  return (
    <Stack
      align="row"
      aria-label="진행 중인 작업"
      data-test-class="steward-composer-capsules"
      data-alignment="center"
      gap="xs"
      justify="center"
      wrap
    >
      {synthesis ? (
        <Button
          aria-label={`${synthesis.safe_title} 보고 준비 상태`}
          className={styles.capsule}
          data-truncation="ellipsis"
          data-test-class="steward-synthesis-capsule"
          disabled={!synthesisChild}
          iconStart={mark}
          onClick={() => synthesisChild && openSessionObserver(synthesisChild.session_id)}
          shape="pill"
          size="xs"
          text={`${synthesis.safe_title} 작업에 대한 보고 준비 중`}
          title={synthesis.safe_title}
          type="button"
          variant="outline"
        />
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
  const taskTitle = child.title.trim().replace(/\s+/gu, " ") || "진행 중인 작업";
  const activityTitle = stewardCurrentActivityTitle(child);
  const progress = stewardPlanProgress(child);
  return (
    <Button
      aria-label={`${taskTitle}, ${activityTitle}${progress ? `, 진행도 ${progress}` : ""}, 진행 상세 보기`}
      className={styles.capsule}
      data-test-class="steward-progress-capsule"
      iconStart={mark}
      onClick={onOpen}
      shape="pill"
      size="xs"
      text={(
        <span className={styles.content}>
          <span className={styles.taskTitle} data-test-class="steward-capsule-task">
            {taskTitle}
          </span>
          <span aria-hidden="true" className={styles.separator}>·</span>
          <span className={styles.activityTitle} data-test-class="steward-capsule-activity">
            {activityTitle}
          </span>
          {progress ? (
            <>
              <span aria-hidden="true" className={styles.separator}>·</span>
              <span className={styles.progress} data-test-class="steward-capsule-progress">
                {progress}
              </span>
            </>
          ) : null}
        </span>
      )}
      title={taskTitle}
      type="button"
      variant="outline"
    />
  );
}
