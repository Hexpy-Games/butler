import { useEffect, useId, useState } from "react";
import { appCopy } from "@/app/copy";
import {
  Button, ButtonContainer, Dialog, DialogContent, DialogForm, Presence, SetupWizardProgress, Spinner, Stack, Tooltip,
} from "@/butler-ds";
import { useBrowserImport } from "../imports/useBrowserImport";
import { importPhase, ImportOutcome, outcomeActions } from "./BrowserImportOutcome";
import { BrowserChoices, BrowserImportItems, ChosenSource, importItems } from "./BrowserImportSources";
import { openImportDiskAccess } from "./signInsApi";

type DialogProps = { open: boolean; onOpenChange: (open: boolean) => void; keychain: boolean; onImported: () => void };

/** Settings → Browser → import: choose a browser, choose what to bring, import. Each open starts a fresh flow. */
export function BrowserImportDialog({ open, onOpenChange, keychain, onImported }: DialogProps) {
  const id = useId();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={appCopy.common.close} aria-describedby={undefined} data-test-class="browser-import-dialog" data-browser-import-dialog={id}>
        <BrowserImportSteps dialogId={id} keychain={keychain} onImported={onImported} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

/** After each step or phase change, focus its first enabled control (the close button when the step has none). */
function useStepFocus(dialogId: string, key: string) {
  useEffect(() => {
    const root = [...document.querySelectorAll<HTMLElement>("[data-browser-import-dialog]")].find(node => node.dataset.browserImportDialog === dialogId);
    if (!root) return;
    const enabled = (selector: string) => [...root.querySelectorAll<HTMLElement>(selector)]
      .find(node => !node.hasAttribute("disabled") && node.getAttribute("aria-disabled") !== "true");
    (enabled("form button, form input") ?? enabled("button"))?.focus({ preventScroll: true });
  }, [dialogId, key]);
}

function BrowserImportSteps({ dialogId, keychain, onImported, onClose }: {
  dialogId: string; keychain: boolean; onImported: () => void; onClose: () => void;
}) {
  const copy = appCopy.settings.browserImport;
  const flow = useBrowserImport(onImported);
  const primaryId = useId();
  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [diskHint, setDiskHint] = useState(false);
  const choice = picked ?? flow.sources?.[0]?.key ?? null;
  const phase = importPhase(flow);
  const view = step === 2 && phase === "idle" ? 1 : step;
  const key = view === 2 ? `import:${phase}` : `${view}:${flow.sources ? "ready" : "loading"}`;
  useStepFocus(dialogId, key);
  const source = choice ?? flow.selected;
  const needsKeychain = flow.passwords && !keychain;
  const blocked = flow.busy || !!flow.exportId || !importItems(flow, source).some(item => item.on) || needsKeychain;

  function run() {
    if (blocked) return;
    setStep(2); setDiskHint(false);
    void flow.run(source);
  }
  function submitPrimary() {
    const input = document.getElementById(primaryId) as HTMLInputElement | null;
    const value = input?.value ?? "";
    if (input) input.value = "";
    void flow.run(flow.selected, value);
  }
  function submit() {
    if (view === 0 && choice) setStep(1);
    else if (view === 1) run();
    else if (phase === "primary") submitPrimary();
  }
  const steps = [{ id: "browser", label: copy.chooseBrowser }, { id: "items", label: copy.chooseItems }, { id: "import", label: copy.run }];
  const body = view === 0
    ? flow.sources ? <BrowserChoices flow={flow} choice={choice} onChoose={setPicked} />
      : <Stack align="row" justify="center" role="status" aria-label={copy.source}><Spinner /></Stack>
    : view === 1
      ? <><ChosenSource flow={flow} source={source} /><BrowserImportItems flow={flow} keychain={keychain} source={source} /></>
      : <ImportOutcome flow={flow} phase={phase} source={flow.selected} primaryId={primaryId} diskHint={diskHint} />;
  const runButton = <Button type="submit" disabled={blocked}>{copy.run}</Button>;
  const footer = view === 0
    ? <ButtonContainer size="default" justify="end">
      <Button type="button" variant="outline" onClick={onClose}>{copy.cancel}</Button>
      <Button type="submit" disabled={!choice}>{copy.next}</Button>
    </ButtonContainer>
    : view === 1
      ? <ButtonContainer size="default" justify="end">
        <Button type="button" variant="outline" disabled={flow.busy} onClick={() => setStep(0)}>{copy.back}</Button>
        {needsKeychain && !flow.busy ? <Tooltip label={copy.needsKeychain}>{runButton}</Tooltip> : runButton}
      </ButtonContainer>
      : outcomeActions(flow, phase, {
        onBack: () => setStep(1),
        onMore: () => { void flow.more(); setStep(0); },
        onClose,
        onDiskAccess: () => void openImportDiskAccess().then(() => setDiskHint(true)),
      });
  return (
    <DialogForm dialog title={copy.open} busy={flow.busy} onSubmit={submit} footer={footer}>
      <SetupWizardProgress steps={steps} activeIndex={view} ariaLabel={copy.steps} />
      <Presence present motion="rise" key={key}>
        <Stack gap="md" data-browser-import-step={steps[view]!.id}>{body}</Stack>
      </Presence>
    </DialogForm>
  );
}
