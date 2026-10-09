import {
  AlertCircle,
  Button,
  ButtonContainer,
  CheckIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Inline,
  IconSlot,
  Notice,
  Spinner,
  Stack,
  Typo,
} from "@/butler-ds";
import { exportFirstRunSetupDiagnostics, localizeSetupDiagnostics } from "@/app/firstRunSetup.ts";
import { notifyStatus } from "@/app/notifications.ts";
import { readinessFailureCode, readinessProgress } from "@/app/setupReadiness.ts";
import { MemoryModelStatus } from "./MemoryModelStatus";
import type { FirstRunFlow } from "./useFirstRunFlow";

/** Subtle background-preparation line; a failure turns into an inline notice with Try again. */
export function FirstRunPrepStatus({ flow, align = "start" }: { flow: FirstRunFlow; align?: "center" | "start" }) {
  return <Stack gap="sm">
    <PreparationLine flow={flow} align={align} />
    <MemoryModelStatus model={flow.readiness.memory_model} language={flow.language} retry={flow.retryPreparation} />
  </Stack>;
}

export function PreparationLine({ flow, align = "start" }: { flow: FirstRunFlow; align?: "center" | "start" }) {
  const { copy, readiness } = flow;
  if (readiness.status === "failed") return <FirstRunPrepFailure flow={flow} />;
  if (readiness.status === "ready") {
    return (
      <Typo.Caption as="div" data-test-class="first-run-prep" role="status">
        <Inline justify={align} cross="start" wrap={false}>
          <IconSlot size="sm" minHeight="line" aria-hidden="true"><CheckIcon size="sm" /></IconSlot>
          <Typo.Caption tone="success">{copy.prepReady}</Typo.Caption>
        </Inline>
      </Typo.Caption>
    );
  }
  const progress = readinessProgress(readiness);
  return (
    <Typo.Caption as="div" data-test-class="first-run-prep" role="status">
      <Inline justify={align} cross="start" wrap={false}>
        <IconSlot size="sm" minHeight="line" aria-hidden="true"><Spinner size={14} /></IconSlot>
        <Typo.Caption tone="secondary" numeric="tabular">{copy.prepWorking}{progress ? ` · ${progress.done}/${progress.total}` : ""}</Typo.Caption>
      </Inline>
    </Typo.Caption>
  );
}

function FirstRunPrepFailure({ flow }: { flow: FirstRunFlow }) {
  const { copy } = flow;
  const code = readinessFailureCode(flow.readiness);
  return (
    <Stack data-test-class="first-run-prep-failed" gap="none" role="alert">
      <Notice
        tone="error"
        icon={<AlertCircle size="md" />}
        title={copy.prepFailed}
        message={copy.prepReasons[code] ?? copy.prepReasons.default}
        action={(
          <ButtonContainer size="sm">
            <Button size="sm" type="button" variant="outline" onClick={flow.retryPreparation}>{copy.retry}</Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" type="button" variant="ghost">{copy.moreActions}</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  <DropdownMenuItem onSelect={flow.repairPreparation}>{copy.repair}</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void copyReport(flow)}>{copy.copyReport}</DropdownMenuItem>
                  <DropdownMenuItem onSelect={quitApp}>{copy.quit}</DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </ButtonContainer>
        )}
      />
    </Stack>
  );
}

async function copyReport(flow: FirstRunFlow): Promise<void> {
  try {
    // Desktop preparation checks plus the agent's readiness steps (code and English detail).
    const diagnostics = localizeSetupDiagnostics(await exportFirstRunSetupDiagnostics(), flow.copy);
    await navigator.clipboard.writeText(JSON.stringify({ ...diagnostics, readiness: flow.readiness }, null, 2));
    notifyStatus(flow.copy.reportCopied, { id: "first-run-report", tone: "ok" });
  } catch {
    notifyStatus(flow.copy.reportUnavailable, { id: "first-run-report", tone: "error" });
  }
}

function quitApp(): void {
  const bridge = window.butlerApp;
  if (typeof bridge?.quitApp === "function") {
    void bridge.quitApp();
    return;
  }
  window.close();
}
