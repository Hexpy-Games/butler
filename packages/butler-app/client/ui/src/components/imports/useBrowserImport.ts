import { useEffect, useRef, useState } from "react";
import { apiErrorCode } from "@/app/api";
import { beginPasswordExport, cancelPasswordExport, choosePasswordExport, deletePasswordExport, listImportSources, pickBrowserFolder, pickImportFile,
  pollPasswordExport, startBrowserImport, undoBrowserImport, type BrowserImportCounts, type BrowserImportInput, type ImportSource } from "../settings/signInsApi";

/** Component-local state: only counts and opaque receipts survive a request. */
export function useBrowserImport(onImported: () => void, enabled = true) {
  const [selected, setSelected] = useState("file");
  const [bookmarks, setBookmarks] = useState(true);
  const [history, setHistory] = useState(true);
  const [passwords, setPasswords] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BrowserImportCounts | null>(null);
  const [exportId, setExportId] = useState<string | null>(null);
  const [undone, setUndone] = useState(false);
  const activeExport = useRef<string | null>(null);
  const mounted = useRef(true);
  const { sources, reload } = useBrowserSources(enabled, setError, mounted);
  const imported = useRef(onImported); imported.current = onImported;
  useEffect(() => () => { mounted.current = false; if (activeExport.current) void cancelPasswordExport(activeExport.current); }, []);
  usePasswordExportPolling({ exportId, setExportId, setResult, setError, onImported: () => imported.current() });

  async function run(source: string, primary?: string) {
    if (busy || exportId) return;
    setSelected(source); setBusy(true); setError(null); setUndone(false);
    try {
      const input: BrowserImportInput = { source, bookmarks, history: source !== "file" && history, passwords, primary_password: primary };
      if (source === "file") {
        if (bookmarks) { const file = await pickImportFile("bookmarks"); if (!file) return; input.bookmarks_path = file.path; }
        if (passwords) { const file = await pickImportFile("passwords"); if (!file) return; input.passwords_path = file.path; }
      }
      const counts = await startBrowserImport(input);
      if (!mounted.current) return;
      setResult(counts); setError(counts.error ?? null); imported.current();
      if (counts.needs_csv && !counts.error) await watch(source, counts.run_id);
    } catch (e) { if (mounted.current) setError(apiErrorCode(e) ?? "import_unreadable"); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function watch(source: string, run: string) {
    const session = await beginPasswordExport(source, run);
    if (!mounted.current) { await cancelPasswordExport(session.export_id); return; }
    activeExport.current = session.export_id; setExportId(session.export_id);
  }
  async function action(work: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await work(); } catch (e) { setError(apiErrorCode(e) ?? "import_unreadable"); }
    finally { setBusy(false); }
  }
  async function folder(source = selected) {
    await action(async () => { const picked = await pickBrowserFolder(source); if (picked.selected) { await reload(); await run(picked.source ?? source); } });
  }
  async function cancel() {
    if (activeExport.current) await cancelPasswordExport(activeExport.current);
    activeExport.current = null; setExportId(null);
  }
  async function more() { await cancel(); setResult(null); setError(null); setUndone(false); }
  async function undo() {
    if (!result) return;
    await action(async () => { if (exportId) await cancel(); await undoBrowserImport(result.run_id); setUndone(true); imported.current(); });
  }
  async function selectCsv() {
    if (!activeExport.current) return;
    const file = await pickImportFile("passwords"); if (!file) return;
    await action(async () => {
      const counts = await choosePasswordExport(activeExport.current!, file.path);
      setExportId(null);
      setResult(prior => ({ ...counts, history: prior?.history ?? 0, bookmarks: prior?.bookmarks ?? 0, existing: prior?.existing ?? 0 }));
      imported.current();
    });
  }
  async function resumeExport() { if (result) await action(() => watch(selected, result.run_id)); }
  async function removeCsv() {
    if (!result?.export_id) return;
    await action(async () => { await deletePasswordExport(result.export_id!); setResult({ ...result, export_id: undefined }); });
  }
  return { sources, selected, bookmarks, setBookmarks, history, setHistory, passwords, setPasswords, busy, error, result, exportId, undone, run, folder, cancel, more, undo, removeCsv, selectCsv, resumeExport };
}

type ExportPolling = {
  exportId: string | null;
  setExportId: (id: string | null) => void;
  setResult: React.Dispatch<React.SetStateAction<BrowserImportCounts | null>>;
  setError: (error: string | null) => void;
  onImported: () => void;
};

function usePasswordExportPolling({ exportId, setExportId, setResult, setError, onImported }: ExportPolling) {
  const callback = useRef(onImported); callback.current = onImported;
  useEffect(() => {
    if (!exportId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const counts = await pollPasswordExport(exportId!);
        if (!live) return;
        if (counts.waiting) { timer = setTimeout(() => void poll(), 1000); return; }
        setResult(prior => ({ ...counts, history: prior?.history ?? 0, bookmarks: (prior?.bookmarks ?? 0) + counts.bookmarks, existing: prior?.existing ?? 0 }));
        setExportId(null); setError(counts.error ?? null); callback.current();
      } catch (e) { if (live) { setError(apiErrorCode(e) ?? "import_unreadable"); setExportId(null); } }
    }
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, [exportId]);
}

function useBrowserSources(enabled: boolean, setError: (error: string | null) => void, mounted: React.RefObject<boolean>) {
  const [sources, setSources] = useState<ImportSource[] | null>(null);
  async function reload() {
    try { const view = await listImportSources(); if (mounted.current) setSources(view.sources); }
    catch (e) { if (mounted.current) { setSources([]); setError(apiErrorCode(e) ?? "import_unreadable"); } }
  }
  useEffect(() => {
    mounted.current = true; if (enabled) void reload();
    return () => { mounted.current = false; };
  }, [enabled]);
  return { sources, reload };
}
