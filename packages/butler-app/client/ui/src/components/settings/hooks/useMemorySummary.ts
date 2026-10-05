import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/app/api.ts";
import type { SettingsSectionState } from "@/butler-ds";
import { onMemoryEvent } from "@/app/memoryEvents.ts";
import type { MemoryInventory, MemoryProject } from "../memoryTypes";

export function useMemorySummary() {
  const [inventory, setInventory] = useState<MemoryInventory>();
  const [state, setState] = useState<SettingsSectionState>("loading");
  const [projects, setProjects] = useState<MemoryProject[]>([]);
  const [projectsState, setProjectsState] = useState<SettingsSectionState>("loading");
  const alive = useRef(false);
  const request = useRef(0);
  const flight = useRef<Promise<void> | undefined>(undefined);
  const pending = useRef(false);
  const reload = useCallback((measure = true) => {
    if (flight.current) { pending.current = true; return flight.current; }
    flight.current = (async () => {
      do {
        pending.current = false;
        const version = ++request.current;
        try {
          const result = await api<MemoryInventory>(measure ? "/memory/inventory/check" : "/memory/inventory", measure ? { method: "POST", body: "{}" } : {});
          if (alive.current && version === request.current) { setInventory(result); setState("ready"); }
        } catch (error) {
          if (alive.current && version === request.current) setState((error as { status?: number }).status === 404 ? "empty" : "error");
        }
      } while (pending.current && alive.current);
    })().finally(() => { flight.current = undefined; });
    return flight.current;
  }, []);
  const reloadProjects = useCallback(async () => {
    try {
      const result = await api<{ projects: MemoryProject[] }>("/projects");
      if (alive.current) { setProjects(result.projects); setProjectsState("ready"); }
    } catch { if (alive.current) setProjectsState("error"); }
  }, []);
  useEffect(() => {
    alive.current = true;
    void reload(true);
    void reloadProjects();
    const off = onMemoryEvent((event) => {
      if (event.type !== "memory.operation" || !event.payload.operation_id) void reload();
      if (event.type.startsWith("project.")) void reloadProjects();
    });
    return () => { alive.current = false; off(); };
  }, [reload, reloadProjects]);
  return { inventory, state, reload, projects, projectsState, reloadProjects };
}
