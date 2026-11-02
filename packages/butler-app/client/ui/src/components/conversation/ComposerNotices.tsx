import { appCopy, useAppLocale } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { Stack, StatusCapsule } from "@/butler-ds";

import { GitDependencyNotice } from "./GitDependencyNotice";

export function ComposerNotices({ child }: {
  child?: { session_id: string; title: string };
}) {
  useAppLocale();
  const open = useButlerStore((state) => state.openSessionObserver);
  if (!child) return <GitDependencyNotice />;
  return <Stack gap="sm" cross="start"><StatusCapsule title={appCopy.interfaceStatus.progress} detail={child.title}
    data-test-class="steward-composer-pill" onClick={() => open(child.session_id)} />
    <GitDependencyNotice />
  </Stack>;
}
