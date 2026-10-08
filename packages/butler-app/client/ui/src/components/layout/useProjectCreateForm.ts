import { splitProjectFolderPath } from "./projectFolderPath";
import { useEffect, useState } from "react";
import { canSelectProjectFolder, selectProjectFolder, type ProjectFolderSelection } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";

export interface ProjectCreateDialogProps {
  open?: boolean;
  creatingProject?: boolean;
  initialDisplayName?: string;
  onOpenChange?: (open: boolean) => void;
  onSubmit?: (displayName: string) => Promise<boolean> | boolean | void;
}

export function useProjectCreateForm(props: ProjectCreateDialogProps) {
  const storeOpen = useButlerStore((s) => s.projectCreateDialogOpen);
  const setStoreOpen = useButlerStore((s) => s.setProjectCreateDialogOpen);
  const creating = useButlerStore((s) => s.creatingProject);
  const scratch = useButlerStore((s) => s.createScratchProject);
  const existing = useButlerStore((s) => s.createProjectFromExistingFolder);
  const open = props.open ?? storeOpen;
  const onOpenChange = props.onOpenChange ?? setStoreOpen;
  const [value, setValue] = useState(props.initialDisplayName ?? "");
  const [folder, setFolder] = useState<ProjectFolderSelection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = (props.creatingProject ?? creating) || busy;
  const canSubmit = value.trim().length > 0 && !pending;

  useEffect(() => {
    if (!open) return;
    setValue(props.initialDisplayName ?? "");
    setFolder(null);
    setError(null);
  }, [open, props.initialDisplayName]);

  async function pickFolder() {
    if (pending || !canSelectProjectFolder()) return;
    setBusy(true);
    try {
      const selection = await selectProjectFolder();
      if (selection.cancelled) return;
      if (!selection.folder_selection_token || !selection.folder_path) {
        setError(appCopy.interfaceFeedback.projectFolderFailed);
        return;
      }
      setFolder(selection);
      setValue((name) => name.trim() ? name : selection.display_name ?? splitProjectFolderPath(selection.folder_path!).basename);
      setError(null);
    } catch {
      setError(appCopy.interfaceFeedback.projectFolderFailed);
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const name = value.trim();
      const result = folder ? await existing(folder, name) : await (props.onSubmit ?? scratch)(name);
      if (result === false) setError(appCopy.interfaceFeedback.projectCreationFailed);
      else onOpenChange(false);
    } catch {
      setError(appCopy.interfaceFeedback.projectCreationFailed);
    } finally {
      setBusy(false);
    }
  }

  function resetFolder() {
    if (pending) return;
    setFolder(null);
    setError(null);
  }

  return { open, value, setValue, folder, error, pending, canSubmit, pickFolder, resetFolder, submit,
    onOpenChange: (next: boolean) => { if (!pending) onOpenChange(next); } };
}
