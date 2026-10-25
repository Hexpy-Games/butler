import { useCallback, useEffect, useRef, useState } from "react";
import { listProjectFolders, type ProjectFolderPage } from "@/app/api";

export function useProjectFolderBrowser(initialPath: string) {
  const [page, setPage] = useState<ProjectFolderPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const focusIndex = useRef(0);
  const currentPath = useRef("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const useRefButton = useRef<HTMLButtonElement>(null);

  const navigate = useCallback(async (path: string, previous?: ProjectFolderPage) => {
    const current = ++generation.current;
    const segments = path ? path.split("/") : [];
    const oldSegments = currentPath.current.split("/");
    const child = !previous && segments.length < oldSegments.length
      && segments.every((segment, index) => segment === oldSegments[index])
      ? oldSegments[segments.length] : undefined;
    setLoading(true);
    setError(false);
    try {
      const next = await listProjectFolders(path, previous?.next_after ?? undefined);
      if (generation.current !== current) return;
      const childIndex = next.folders.findIndex(folder => folder.name === child);
      focusIndex.current = previous ? previous.folders.length + (path ? 1 : 0)
        : childIndex >= 0 ? childIndex + (path ? 1 : 0) : 0;
      currentPath.current = path;
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
    const rows = scrollRef.current?.querySelectorAll<HTMLElement>('[data-test-class="project-folder-up"], [data-test-class="project-folder-row"]');
    const useButton = useRefButton.current;
    const fallback = useButton && !useButton.disabled ? useButton
      : scrollRef.current?.querySelector<HTMLElement>('[data-test-class="project-folder-empty"]');
    (rows?.[focusIndex.current] ?? fallback)?.focus();
  }, [page, loading]);

  const path = page?.path ?? "";
  return { page, loading, error, scrollRef, useRefButton, navigate,
    parent: () => { if (path) void navigate(path.split("/").slice(0, -1).join("/")); } };
}
