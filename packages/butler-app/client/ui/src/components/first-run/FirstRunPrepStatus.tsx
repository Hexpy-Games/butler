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
  Notice,
  Spinner,
  Stack,
  Typo,
} from "@/butler-ds";
import { exportFirstRunSetupDiagnostics, localizeSetupDiagnostics } from "@/app/firstRunSetup.ts";
import { notifyStatus } from "@/app/notifications.ts";
import { readinessFailureCode, readinessProgress } from "@/app/setupReadiness.ts";
import type { FirstRunFlow } from "./useFirstRunFlow";

/** Subtle background-preparation line; a failure turns into an inline notice with Try again. */
export function FirstRunPrepStatus({ flow, align = "center" }: { flow: FirstRunFlow; align?: "center" | "start" }) {
  const { copy, readiness } = flow;
  if (readiness.status === "failed") return <FirstRunPrepFailure flow={flow} />;
  if (readiness.status === "ready") {
    return (
      <Inline data-test-class="first-run-prep" justify={align} role="status">
        <CheckIcon size="sm" />
        <Typo.Caption tone="success">{copy.prepReady}</Typo.Caption>
      </Inline>
    );
  }
  const progress = readinessProgress(readiness);
  return (
    <Inline data-test-class="first-run-prep" justify={align} role="status">
      <Spinner size={14} />
      <Typo.Caption tone="secondary">{copy.prepWorking}</Typo.Caption>
      {progress ? <Typo.Caption numeric="tabular" tone="tertiary">{`${progress.done}/${progress.total}`}</Typo.Caption> : null}
    </Inline>
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
