import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/app/api.ts";
import { onMemoryEvent } from "@/app/memoryEvents.ts";
import type { SettingsSectionState } from "@/butler-ds";
import type { MemoryProject, ProjectMemory } from "../memoryTypes";
export function useProjectMemory(projects: MemoryProject[]) {
  const [selection, select] = useState("");
  const selected = projects.some((p) => p.id === selection) ? selection : projects[0]?.id ?? "";
  const [memory, setMemory] = useState<ProjectMemory>();
  const [state, setState] = useState<SettingsSectionState>("loading");
  const request = useRef(0);
  const reload = useCallback(async () => {
    if (!selected) return;
    const version = ++request.current;
    try {
      const result = await api<ProjectMemory>(`/memory/projects/${encodeURIComponent(selected)}`);
      if (version === request.current) { setMemory(result); setState("ready"); }
    } catch (error) { if (version === request.current) setState((error as { status?: number }).status === 404 ? "empty" : "error"); }
  }, [selected]);
  useEffect(() => {
    setState("loading");
    void reload();
    const off = onMemoryEvent((event) => {
      if (event.type !== "memory.operation" || event.payload.kind === "instructions" || ["complete", "failed", "cancelled"].includes(String(event.payload.phase))) void reload();
    });
    return () => { ++request.current; off(); };
  }, [reload]);
  return { selected, select, memory, state, reload };
}
