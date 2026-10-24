import { useCallback, useEffect, useRef, useState } from "react";
import { getCanonTags, type CanonTag } from "@/app/canonApi.ts";
import { subscribeCanonChanges } from "@/app/canonEvents.ts";
import { notifyError } from "@/app/notifications.ts";
import { appCopy } from "@/app/copy.ts";
export function useCanonTags(projectId: string) {
  const [tags, setTags] = useState<CanonTag[]>([]);
  const epoch = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++epoch.current;
    try {
      const tags = await getCanonTags(projectId);
      if (current === epoch.current) setTags(tags);
    } catch (error) {
      if (current === epoch.current) notifyError(error, appCopy.interfaceFeedback.requestFailed);
    }
  }, [projectId]);
  useEffect(() => {
    setTags([]);
    void refresh();
    let queued = false, active = true;
    const unsubscribe = subscribeCanonChanges(event => {
      if (event && (!("kind" in event) || event.kind !== "tag")) return;
      if (queued) return;
      queued = true;
      queueMicrotask(() => { queued = false; if (active) void refresh(); });
    }, { projectId });
    return () => { active = false; epoch.current++; unsubscribe(); };
  }, [projectId, refresh]);
  return { tags, refresh };
}
