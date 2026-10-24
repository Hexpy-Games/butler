import { useEffect, useState } from "react";
import { EpicInspector } from "../canon/EpicInspector.tsx";
import { ErrorBoundary } from "@/components/common/ErrorBoundary.tsx";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { FileText, InspectorShell } from "@/butler-ds";
import { useButlerStore, selectEffectiveRightOpen } from "@/app/store.ts";

/** The dashboard inspector remains until its aside migration. */
export function Inspector({ id }: { id?: string } = {}) {
  useAppLocale();
  const isOpen = useButlerStore(selectEffectiveRightOpen);
  const setRightTab = useButlerStore(state => state.setRightTab);
  const view = useButlerStore(state => state.view);
  const selected = view.kind === "project-dashboard" && view.epicId ? view : null;
  const [last, setLast] = useState(selected);
  useEffect(() => { if (selected) setLast(selected); }, [selected]);
  const epic = selected ?? (view.kind === "project-dashboard" && last?.projectId === view.projectId ? last : null);
  if (view.kind !== "project-dashboard") return null;
  return <InspectorShell activeTab="epic" id={id} open={isOpen} onTabChange={setRightTab}
    tabs={[{ id: "epic", label: appCopy.canon.epic, icon: <FileText size="md" /> }]}>
    {epic && <ErrorBoundary key={epic.epicId} scope="inspector-epic">
      <EpicInspector focusTitle={isOpen} key={epic.epicId} projectId={epic.projectId} epicId={epic.epicId!} />
    </ErrorBoundary>}
  </InspectorShell>;
}
