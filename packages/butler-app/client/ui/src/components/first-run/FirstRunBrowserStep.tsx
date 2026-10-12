import { useState } from "react";
import { appCopy } from "@/app/copy";
import {
  Button, ButtonContainer, CheckCircle2, ChoiceCard, ChoiceCardList, Download, EmptyLine, FileText, Globe2, Inline, Notice,
  SetupWizardStepAction, Spinner, Stack, Typo,
} from "@/butler-ds";
import { BrowserImportItems } from "../settings/BrowserImportSources";
import { type ImportSource } from "../settings/signInsApi";
import { BrowserImportFeedback } from "../imports/BrowserImportFeedback";
import { FirstRunStepCard } from "./FirstRunStepCard";
import type { FirstRunFlow } from "./useFirstRunFlow";

const BRANDS: Record<string, string> = { chrome: "Chrome", chromium: "Chromium", edge: "Edge", brave: "Brave", arc: "Arc", whale: "Whale", firefox: "Firefox", zen: "Zen", safari: "Safari" };

function BrandIcon({ browser }: { browser: string }) {
  if (!BRANDS[browser]) return <Globe2 size="md" />;
  return <img src={`/browser-icons/${browser}.${browser === "whale" ? "png" : "svg"}`} width={20} height={20} alt="" />;
}

/** Import ②: one detected browser profile at a time, what to bring, then Import; Next after a result. */
export function FirstRunBrowserStep({ flow }: { flow: FirstRunFlow }) {
  const proposal = { ...flow.copy, ...flow.copy.import };
  const copy = appCopy.settings.browserImport;
  const { browserImport: imp, keychain } = flow;
  const [chosen, setChosen] = useState<string | null>(null);
  const sources = imp.sources;
  const current = sources?.find(source => source.key === chosen) ?? sources?.find(source => source.permission !== "denied") ?? sources?.[0];
  const denied = current?.permission === "denied";
  const nothing = !imp.bookmarks && !imp.passwords && !imp.history;
  const done = Boolean(imp.result) && !imp.error;
  const empty = sources !== null && !imp.error && sources.length === 0;
  const primary = denied ? copy.pickFolder : imp.busy ? proposal.importing : proposal.importAction;
  return (
    <FirstRunStepCard flow={flow} contentKey="browsers" icon={<Download size="lg" />} title={proposal.browsersTitle}
      titleId="first-run-browsers-title" description={proposal.browsersBody} onBack={flow.backFromImport}
      actions={done || empty || imp.undone
        ? <SetupWizardStepAction forward disabled={imp.busy || !!imp.exportId} onClick={flow.finishImport}>{proposal.next}</SetupWizardStepAction>
        : <>
          <SetupWizardStepAction disabled={imp.busy || !!imp.exportId} onClick={flow.finishImport}>{proposal.skip}</SetupWizardStepAction>
          <SetupWizardStepAction variant="default" disabled={imp.busy || !!imp.exportId || !current || (!denied && (nothing || (imp.passwords && !keychain)))}
            onClick={() => current && void (denied ? imp.folder(current.key) : imp.run(current.key))}>{primary}</SetupWizardStepAction>
        </>}
    >
      {sources === null ? (
        <Inline role="status"><Spinner size={14} /><Typo.Caption tone="secondary">{proposal.searching}</Typo.Caption></Inline>
      ) : empty ? <EmptyLine message={proposal.browsersEmpty} /> : done ? null : <>
        <ChoiceCardList aria-labelledby="first-run-browsers-title" role="radiogroup">
          {sources.map(source => <SourceCard key={source.key} source={source} selected={source.key === current?.key}
            disabled={imp.busy} onPick={() => setChosen(source.key)} />)}
        </ChoiceCardList>
        <BrowserImportItems flow={imp} keychain={keychain} />
        <ButtonContainer size="sm"><Button size="sm" variant="ghost" iconStart={<FileText size="sm" />}
          disabled={imp.busy || (!imp.bookmarks && !imp.passwords)} onClick={() => void imp.run("file")}>{copy.fromFile}</Button></ButtonContainer>
      </>}
      {imp.result && !imp.error ? (
        <Stack gap="sm">
          <Notice tone="neutral" icon={<CheckCircle2 size="md" />}
            message={imp.undone ? copy.undone : copy.result(imp.result.bookmarks, imp.result.passwords, imp.result.updated, imp.result.history ?? 0, imp.result.invalid ?? 0)} />
          {imp.undone ? null : <ButtonContainer size="sm">
            <Button size="sm" variant="outline" disabled={imp.busy} onClick={() => void imp.undo()}>{copy.undo}</Button>
            <Button size="sm" variant="ghost" disabled={imp.busy} onClick={() => void imp.more()}>{copy.more}</Button>
            {imp.result.needs_csv && !imp.exportId && !imp.result.export_id ? <Button size="sm" variant="outline" disabled={imp.busy} onClick={() => void imp.resumeExport()}>{copy.exportPasswords}</Button> : null}
            {imp.result.export_id ? <Button size="sm" variant="outline" disabled={imp.busy} onClick={() => void imp.removeCsv()}>{copy.deleteCsv}</Button> : null}
          </ButtonContainer>}
        </Stack>
      ) : null}
      <BrowserImportFeedback flow={imp} />
    </FirstRunStepCard>
  );
}

function SourceCard({ source, selected, disabled, onPick }: { source: ImportSource; selected: boolean; disabled: boolean; onPick: () => void }) {
  const copy = appCopy.settings.browserImport;
  const brand = BRANDS[source.browser] ?? source.browser;
  const denied = source.permission === "denied";
  return <ChoiceCard role="radio" aria-checked={selected} selected={selected} chevron={false} data-import-source={source.key}
    icon={<BrandIcon browser={source.browser} />} title={brand}
    description={denied ? copy.fullDiskAccess : source.name === brand ? undefined : source.name}
    state={disabled ? "disabled" : "default"} onClick={onPick} />;
}
