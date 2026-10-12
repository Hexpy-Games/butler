import { appCopy } from "@/app/copy";
import { Button, ButtonContainer, Globe2, ListRow, SetupWizardStepAction, Stack } from "@/butler-ds";
import { BrandIcon, browserBrand } from "../settings/BrowserImportSources";
import { BrowserImportFeedback } from "../imports/BrowserImportFeedback";
import { FirstRunStepCard } from "./FirstRunStepCard";
import type { FirstRunFlow } from "./useFirstRunFlow";

/**
 * Import ② after the run: what came over from the browser and any follow-up (Safari passwords via a
 * CSV export). No undo in first run; Settings changes things later.
 */
export function FirstRunBrowserResult({ flow }: { flow: FirstRunFlow }) {
  const copy = appCopy.settings.browserImport;
  const imp = flow.browserImport;
  const result = imp.result!;
  const source = imp.sources?.find((entry) => entry.key === imp.selected);
  const brand = source ? browserBrand(source.browser) : copy.fromFile;
  const title = source && source.name !== brand ? `${brand} · ${source.name}` : brand;
  return (
    <FirstRunStepCard flow={flow} contentKey="browsers:done" title={flow.copy.import.browsersDoneTitle}
      titleId="first-run-browsers-done-title" onBack={flow.backFromImport}
      actions={<SetupWizardStepAction forward disabled={imp.busy || !!imp.exportId} onClick={flow.finishImport}>{flow.copy.next}</SetupWizardStepAction>}
    >
      <Stack gap="sm" role="status">
        <ListRow icon={source ? <BrandIcon browser={source.browser} /> : <Globe2 size="md" />} title={title}
          description={copy.result(result.bookmarks, result.passwords, result.updated, result.history ?? 0, result.invalid ?? 0)} />
        {result.needs_csv && !imp.exportId && !result.export_id ? (
          <ButtonContainer size="sm"><Button size="sm" variant="outline" disabled={imp.busy} onClick={() => void imp.resumeExport()}>{copy.exportPasswords}</Button></ButtonContainer>
        ) : null}
        {result.export_id ? (
          <ButtonContainer size="sm"><Button size="sm" variant="outline" disabled={imp.busy} onClick={() => void imp.removeCsv()}>{copy.deleteCsv}</Button></ButtonContainer>
        ) : null}
      </Stack>
      <BrowserImportFeedback flow={imp} />
    </FirstRunStepCard>
  );
}
