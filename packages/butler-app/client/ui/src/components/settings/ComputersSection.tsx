import { appCopy } from "@/app/copy.ts";
import type { SavedCredentialView } from "@/app/types";
import { Button } from "@/butler-ds";
import { ComputerAddDialog } from "./ComputerAddDialog";
import { ComputerAiDialog } from "./ComputerAiDialog";
import { ComputerDeleteDialog } from "./ComputerDeleteDialog";
import { ComputerRow } from "./ComputerRow";
import { SettingsSection } from "./SettingsFormComponents";
import type { ComputersSectionState } from "./hooks/useComputersSection";

export function computersSection({ section, savedKeys }: {
  section: ComputersSectionState;
  savedKeys: SavedCredentialView[];
}) {
  const copy = appCopy.computers;
  const { computers } = section;
  return (
    <SettingsSection
      id="computers" kind="list" title={copy.title} description={copy.description}
      state={computers.state === "ready" && !computers.computers.length ? "empty" : computers.state}
      emptyMessage={copy.empty} onRetry={() => void computers.refresh()}
      actions={<>
        <Button size="sm" variant="outline" onClick={() => section.setAdding(true)}>{copy.add}</Button>
        <ComputerAddDialog open={section.adding || section.editing !== null} editing={section.editing}
          onOpenChange={(open) => {
            if (!open) {
              section.setAdding(false);
              section.setEditing(null);
            }
          }} onAdded={section.added}
          mainModel={computers.mainModel} savedKeys={savedKeys} />
        <ComputerAiDialog key={section.aiFor?.id ?? "none"} computer={section.aiFor} savedKeys={savedKeys} onClose={section.aiClosed} />
        <ComputerDeleteDialog computer={section.removing?.computer ?? null}
          unreachable={section.removing?.unreachable ?? false} forget={section.removing?.forget ?? false}
          onForgetChange={(forget) => section.setRemoving((current) => current && { ...current, forget })}
          onCancel={() => section.setRemoving(null)} onConfirm={section.confirmRemove} />
      </>}
    >
      {computers.computers.map((computer) => (
        <ComputerRow key={computer.id} computer={computer} status={computers.statusOf(computer)} busy={computers.busy}
          onEdit={() => section.setEditing(computer)} onRemove={() => section.setRemoving({ computer, forget: false, unreachable: false })} />
      ))}
    </SettingsSection>
  );
}
