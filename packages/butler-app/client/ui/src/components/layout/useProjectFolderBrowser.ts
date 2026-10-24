import { useCallback, useEffect, useRef, useState } from "react";
import { listProjectFolders, type ProjectFolderPage } from "@/app/api";

export function useProjectFolderBrowser(initialPath: string) {
  const [page, setPage] = useState<ProjectFolderPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const focusIndex = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const useRefButton = useRef<HTMLButtonElement>(null);

  const navigate = useCallback(async (path: string, previous?: ProjectFolderPage) => {
    const current = ++generation.current;
    setLoading(true);
    setError(false);
    try {
      const next = await listProjectFolders(path, previous?.next_after ?? undefined);
      if (generation.current !== current) return;
      focusIndex.current = previous?.folders.length ?? 0;
      setPage(previous ? { ...next, folders: [...previous.folders, ...next.folders] } : next);
    } catch {
      if (generation.current !== current) return;
      setError(true);
      if (!previous) setPage(null);
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void navigate(initialPath);
    return () => { generation.current += 1; };
  }, [initialPath, navigate]);

  useEffect(() => {
    if (loading) return;
    const rows = scrollRef.current?.querySelectorAll<HTMLElement>('[data-test-class="project-folder-row"]');
    const useButton = useRefButton.current;
    const fallback = useButton && !useButton.disabled ? useButton
      : scrollRef.current?.querySelector<HTMLElement>('[data-test-class="project-folder-empty"]');
    (rows?.[focusIndex.current] ?? fallback)?.focus();
  }, [page, loading]);

  const path = page?.path ?? "";
  return { page, loading, error, scrollRef, useRefButton, navigate,
    parent: () => { if (path) void navigate(path.split("/").slice(0, -1).join("/")); } };
}
