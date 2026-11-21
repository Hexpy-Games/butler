import { useEffect, useState } from "react";
import type { CanonSidebar } from "../../../butler-protocol/src/index.ts";
import { useConversation } from "./live";

/** Each listed project's Canon sidebar, reread on Canon and space changes for that project. */
export function useCanonSidebars(projectIds: readonly string[]): ReadonlyMap<string, CanonSidebar> {
  const { client, subscribe, reconcile } = useConversation();
  const [sidebars, setSidebars] = useState<ReadonlyMap<string, CanonSidebar>>(new Map());
  const key = projectIds.join("\n");
  useEffect(() => {
    if (!client || !key) return;
    let closed = false;
    const ids = key.split("\n");
    const load = (id: string) => client.request<CanonSidebar>(`/projects/${encodeURIComponent(id)}/canon/sidebar`)
      .then(sidebar => { if (!closed) setSidebars(previous => new Map(previous).set(id, sidebar)); })
      .catch(() => {});
    ids.forEach(id => void load(id));
    const unsubscribe = subscribe(event => {
      if (!event.type.startsWith("canon.") && event.type !== "space.changed") return;
      const project = event.payload?.project_id;
      for (const id of ids) if (typeof project !== "string" || project === id) void load(id);
    });
    return () => { closed = true; unsubscribe(); };
  }, [client, subscribe, key, reconcile]);
  return sidebars;
}
