import type { StewardSessionSummaryView } from "@/app/types.ts";
import { useButlerStore } from "@/app/store.ts";
import { Button, Stack } from "@/butler-ds";
import { ButlerThinkingMark } from "@/components/common/ButlerThinkingMark.tsx";
import {
  activeStewardChildren,
  stewardProgressCapsule,
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
        <Button
          aria-label={`${child.title} 진행 상세 보기`}
          className={styles.capsule}
          data-truncation="ellipsis"
          data-test-class="steward-progress-capsule"
          iconStart={mark}
          key={child.session_id}
          onClick={() => openSessionObserver(child.session_id)}
          shape="pill"
          size="xs"
          text={stewardProgressCapsule(child)}
          title={child.title}
          type="button"
          variant="outline"
        />
      ))}
    </Stack>
  );
}
