import { useCallback, useEffect, useRef, useState } from "react";
import { GatewayError } from "../../../../butler-protocol/src/client/index.ts";
import { useConversation } from "@/conversation/live";
import type { ConsolidationStatus, InstructionsView, MemoryInventory, MemoryProjectsView, PatternsView, ProjectMemory, SetupReadinessView } from "../types";

export function useMemoryData() {
  const { client, reconcile, subscribe } = useConversation();
  const [inventory, setInventory] = useState<MemoryInventory>();
  const [projects, setProjects] = useState<MemoryProjectsView>();
  const [instructions, setInstructions] = useState<InstructionsView>();
  const [patterns, setPatterns] = useState<PatternsView>();
  const [status, setStatus] = useState<ConsolidationStatus>();
  const [project, setProject] = useState<ProjectMemory>();
  const [errors, setErrors] = useState<Record<string, boolean>>({});
  const [unavailable, setUnavailable] = useState(false);
  const [selection, select] = useState("");
  const selected = projects?.projects.some(p => p.id === selection) ? selection : projects?.projects[0]?.id ?? "";
  const versions = useRef(new Map<string, number>());
  const read = useCallback(async <T,>(key: string, path: string, receive: (value: T) => void, measure = false) => {
    if (!client) return;
    const version = (versions.current.get(key) ?? 0) + 1;
    versions.current.set(key, version);
    try {
      const next = await client.request<T>(path, measure ? { method: "POST", body: {} } : undefined);
      if (versions.current.get(key) !== version) return;
      receive(next);
      setErrors(old => ({ ...old, [key]: false }));
      if (key === "instructions") setUnavailable(false);
    } catch (error) {
      if (versions.current.get(key) !== version) return;
      const missing = key === "instructions" && error instanceof GatewayError && error.status === 404;
      setErrors(old => ({ ...old, [key]: !missing }));
      if (missing) { setUnavailable(true); setInstructions({ instructions: [] }); }
    }
  }, [client]);
  const reloadInventory = useCallback(() => read("inventory", "/memory/inventory/check", setInventory, true), [read]);
  const reloadProjects = useCallback(() => read("projects", "/projects", setProjects), [read]);
  const reloadProject = useCallback(() => selected
    ? read("project", `/memory/projects/${encodeURIComponent(selected)}`, setProject) : Promise.resolve(), [read, selected]);
  const reload = useCallback(async () => {
    await Promise.all([reloadInventory(), reloadProjects(),
      read("instructions", "/memory/instructions", setInstructions), read("patterns", "/memory/patterns", setPatterns),
      read("status", "/memory/consolidation", setStatus)]);
  }, [read, reloadInventory, reloadProjects]);
  useEffect(() => { setProject(undefined); void reloadProject(); }, [reloadProject]);
  useEffect(() => { void reload(); }, [reload, reconcile]);
  useEffect(() => subscribe(event => {
    if (event.type === "memory.operation" && (!event.payload?.operation_id || ["complete", "failed", "cancelled"].includes(String(event.payload.phase)))) void reload();
    if (event.type.startsWith("project.")) void reloadProjects();
    if (event.type === "personalization.updated") void reloadInventory();
  }), [subscribe, reload, reloadProjects, reloadInventory]);
  useEffect(() => () => { versions.current.forEach((v, k) => versions.current.set(k, v + 1)); }, [client]);
  const readiness = useMemoryReadiness();
  return { inventory, projects: projects?.projects, instructions, patterns, status, project, errors, unavailable,
    selected, select, reload, ...readiness };
}

function useMemoryReadiness() {
  const { client, reconcile } = useConversation();
  const [readiness, setReadiness] = useState<SetupReadinessView | null>(null);
  const model = readiness?.memory_model;
  const settled = readiness !== null && (!model || ["unset", "off", "ready", "failed"].includes(model.state));
  useEffect(() => { setReadiness(null); }, [client, reconcile]);
  useEffect(() => {
    if (!client || settled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const next = await client.request<SetupReadinessView>("/setup/readiness"); if (!cancelled) setReadiness(next); }
      catch { /* Reconnect on the next read. */ }
      if (!cancelled) timer = setTimeout(() => void poll(), 800);
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [client, settled, reconcile]);
  return { readiness, setReadiness };
}
