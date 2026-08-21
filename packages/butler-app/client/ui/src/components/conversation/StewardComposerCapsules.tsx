import type { StewardSessionSummaryView } from "@/app/types.ts";
import { useButlerStore } from "@/app/store.ts";
import { Button, Stack } from "@/butler-ds";
import {
  activeStewardChildren,
  stewardProgressCapsule,
} from "./stewardProgressPresentation.ts";

export function StewardComposerCapsules({
  children,
}: {
  children: StewardSessionSummaryView[];
}) {
  const openSessionObserver = useButlerStore(
    (state) => state.openSessionObserver,
  );
  const activeChildren = activeStewardChildren(children);
  if (activeChildren.length === 0) return null;

  return (
    <Stack
      align="row"
      aria-label="진행 중인 작업"
      data-test-class="steward-composer-capsules"
      gap="xs"
      wrap
    >
      {activeChildren.map((child) => (
        <Button
          aria-label={`${child.title} 진행 상세 보기`}
          data-test-class="steward-progress-capsule"
          key={child.session_id}
          onClick={() => openSessionObserver(child.session_id)}
          shape="pill"
          size="xs"
          text={stewardProgressCapsule(child)}
          type="button"
          variant="outline"
        />
      ))}
    </Stack>
  );
}
