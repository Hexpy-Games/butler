import { appCopy, useAppLocale } from "@/app/copy";
import { useComputerConnections } from "@/app/computerEvents";
import { useButlerStore } from "@/app/store";
import { draftSessionTarget } from "@/app/utils";
import { ComposerSelectControl, Monitor, Select, SelectContent, SelectItem, SelectValue } from "@/butler-ds";
import { computerStatus } from "@/components/settings/hooks/useComputers";
import { useComposerStore } from "./composerStore";
import { useComposerComputers } from "./hooks/useComposerComputers";

export function ComposerLocationSelect() {
  useAppLocale();
  const draftId = useComposerStore((store) => store.draftSessionId);
  const computerId = useComposerStore((store) => store.computerId);
  const setComputerId = useComposerStore((store) => store.setComputerId);
  const isSending = useComposerStore((store) => store.isSending);
  const canShow = useButlerStore((store) => {
    const draft = draftSessionTarget(store.navigation, draftId);
    return draft.kind === "chat" && !draft.projectId;
  });
  const computers = useComposerComputers(canShow);
  const states = useComputerConnections((store) => store.states);

  if (!canShow || !computers.length) return null;
  const copy = appCopy.computers;
  return (
    <Select value={computerId || "local"} disabled={isSending}
      onValueChange={(value) => setComputerId(value === "local" ? "" : value)}>
      <ComposerSelectControl aria-label={copy.location} data-test-class="composer-location-select" icon={<Monitor size="sm" />}>
        <SelectValue>{computers.find((computer) => computer.id === computerId)?.name ?? copy.thisComputer}</SelectValue>
      </ComposerSelectControl>
      <SelectContent position="popper" side="top">
        <SelectItem value="local">{copy.thisComputer}</SelectItem>
        {computers.map((computer) => {
          const status = computerStatus(computer, states[computer.id] ?? "idle");
          const disabled = status === "disconnected" || status === "aiNeeded";
          return <SelectItem key={computer.id} value={computer.id} disabled={disabled}>
            {disabled ? `${computer.name} · ${copy.status[status]}` : computer.name}
          </SelectItem>;
        })}
      </SelectContent>
    </Select>
  );
}
