import type { ReactNode } from "react";
import { appCopy } from "@/app/copy";
import { Button, ButtonContainer, Field, FieldError, FieldLabel, Input, Notice, Spinner, Stack, Typo } from "@/butler-ds";
import type { useBrowserImport } from "../imports/useBrowserImport";
import { ChosenSource, importItems } from "./BrowserImportSources";

type ImportFlow = ReturnType<typeof useBrowserImport>;

/** Where step 3 stands; `idle` means nothing ran (a picker was cancelled), so the dialog shows step 2 again. */
export type ImportPhase = "idle" | "progress" | "csv" | "permission" | "primary" | "error" | "done";

export function importPhase(flow: ImportFlow): ImportPhase {
  if (flow.busy && !flow.result) return "progress";
  if (flow.exportId) return "csv";
  if (flow.error === "full_disk_access_required") return "permission";
  if (flow.error === "primary_password_required" || flow.error === "incorrect_primary_password") return "primary";
  if (flow.error) return "error";
  if (flow.result) return "done";
  return flow.busy ? "progress" : "idle";
}

/** Step 3 body: the chosen source with what it brings (or brought), then the phase's own line. */
export function ImportOutcome({ flow, phase, source, primaryId, diskHint }: {
  flow: ImportFlow; phase: ImportPhase; source: string; primaryId: string; diskHint: boolean;
}) {
  const copy = appCopy.settings.browserImport;
  const result = flow.result;
  const detail = result
    ? copy.result(result.bookmarks, result.passwords, result.updated, result.history ?? 0, result.invalid ?? 0)
    : importItems(flow, source).filter(item => item.on).map(item => item.label).join(" · ");
  const chosen = <ChosenSource flow={flow} source={source} detail={detail} />;
  if (phase === "done") return <Stack gap="md" role="status" data-test-class="import-result">{chosen}</Stack>;
  return (
    <Stack gap="md">
      {chosen}
      {phase === "progress" ? <Stack align="row" gap="sm" cross="center" role="status" data-test-class="import-progress">
        <Spinner /><Typo.Text>{copy.importing}</Typo.Text>
      </Stack> : null}
      {phase === "csv" ? <Stack align="row" gap="sm" cross="center" role="status" data-test-class="import-csv">
        <Spinner /><Typo.Text>{copy.waitingCsv}</Typo.Text>
      </Stack> : null}
      {phase === "permission" ? <Stack gap="sm" role="alert" data-test-class="import-permission">
        <Notice tone="error" title={copy.failed} message={copy.fullDiskAccess} />
        {diskHint ? <Typo.Caption tone="secondary">{copy.restartAfterAccess}</Typo.Caption> : null}
      </Stack> : null}
      {phase === "primary" ? <Field>
        <FieldLabel htmlFor={primaryId}>{copy.primaryPassword}</FieldLabel>
        <Input id={primaryId} type="password" autoComplete="off" aria-invalid={flow.error === "incorrect_primary_password" || undefined} />
        {flow.error === "incorrect_primary_password" ? <FieldError>{copy.wrongPrimaryPassword}</FieldError> : null}
      </Field> : null}
      {phase === "error" ? <Stack role="alert" data-test-class="import-error">
        <Notice tone="error" title={flow.error === "browser_locked" ? copy.failed : undefined}
          message={flow.error === "browser_locked" ? copy.closeBrowser : copy.failed} />
      </Stack> : null}
    </Stack>
  );
}

export interface OutcomeActions {
  onBack: () => void;
  onMore: () => void;
  onClose: () => void;
  onDiskAccess: () => void;
}

/** Step 3 footer, right-aligned with the primary action last. */
export function outcomeActions(flow: ImportFlow, phase: ImportPhase, actions: OutcomeActions): ReactNode {
  const copy = appCopy.settings.browserImport;
  const busy = flow.busy;
  const outline = (label: string, onClick: () => void) =>
    <Button key={label} type="button" variant="outline" disabled={busy} onClick={onClick}>{label}</Button>;
  const primary = (label: string, onClick?: () => void) =>
    <Button key={label} type={onClick ? "button" : "submit"} disabled={busy} onClick={onClick}>{label}</Button>;
  const buttons: Record<ImportPhase, ReactNode[]> = {
    idle: [],
    progress: [<Button key="done" type="button" disabled>{copy.done}</Button>],
    csv: [outline(copy.cancel, () => void flow.cancel()), primary(copy.chooseFile, () => void flow.selectCsv())],
    permission: [outline(copy.diskAccess, actions.onDiskAccess), primary(copy.pickFolder, () => void flow.folder())],
    primary: [outline(copy.back, actions.onBack), primary(copy.run)],
    error: [outline(copy.back, actions.onBack), primary(copy.retry, () => void flow.run(flow.selected))],
    done: [
      ...(flow.result?.needs_csv && !flow.result.export_id ? [outline(copy.exportPasswords, () => void flow.resumeExport())] : []),
      ...(flow.result?.export_id ? [outline(copy.deleteCsv, () => void flow.removeCsv())] : []),
      outline(copy.more, actions.onMore),
      primary(copy.done, actions.onClose),
    ],
  };
  return <ButtonContainer size="default" justify="end" wrap>{buttons[phase]}</ButtonContainer>;
}
