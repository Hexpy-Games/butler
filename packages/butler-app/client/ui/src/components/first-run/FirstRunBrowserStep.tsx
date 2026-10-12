import { useState } from "react";
import { appCopy } from "@/app/copy";
import {
  Button,
  ButtonContainer,
  ChoiceCard,
  ChoiceCardList,
  EmptyLine,
  FileText,
  Inline,
  SetupWizardStepAction,
  Spinner,
  Tooltip,
  Typo,
} from "@/butler-ds";
import { BrandIcon, BrowserImportItems, browserBrand } from "../settings/BrowserImportSources";
import type { ImportSource } from "../settings/signInsApi";
import { BrowserImportFeedback } from "../imports/BrowserImportFeedback";
import { FirstRunBrowserResult } from "./FirstRunBrowserResult";
import { FirstRunStepCard } from "./FirstRunStepCard";
import type { FirstRunFlow } from "./useFirstRunFlow";

/** Import ②: one detected browser profile, what to bring, then Import; the result is its own screen. */
export function FirstRunBrowserStep({ flow }: { flow: FirstRunFlow }) {
  const text = { ...flow.copy, ...flow.copy.import };
  const copy = appCopy.settings.browserImport;
  const { browserImport: imp, keychain } = flow;
  const [chosen, setChosen] = useState<string | null>(null);
  if (flow.browsersDone) return <FirstRunBrowserResult flow={flow} />;
  const sources = imp.sources;
  const current = sources?.find(source => source.key === chosen) ?? sources?.find(source => source.permission !== "denied") ?? sources?.[0];
  const denied = current?.permission === "denied";
  const nothing = !imp.bookmarks && !imp.passwords && !imp.history;
  const keychainBlocked = !denied && imp.passwords && !keychain;
  const empty = sources !== null && !imp.error && sources.length === 0;
  const primary = denied ? copy.pickFolder : imp.busy ? text.importing : text.importAction;
  return (
    <FirstRunStepCard flow={flow} contentKey="browsers" title={text.browsersTitle}
      titleId="first-run-browsers-title" description={text.browsersBody} onBack={flow.backFromImport}
      actions={empty
        ? <SetupWizardStepAction forward disabled={imp.busy || !!imp.exportId} onClick={flow.finishImport}>{text.next}</SetupWizardStepAction>
        : <>
          <SetupWizardStepAction disabled={imp.busy || !!imp.exportId} onClick={flow.finishImport}>{text.skip}</SetupWizardStepAction>
          <Tooltip label={imp.busy || denied ? undefined : nothing ? text.pickOne : keychainBlocked ? copy.needsKeychain : undefined}>
            <SetupWizardStepAction variant="default" disabled={imp.busy || !!imp.exportId || !current || (!denied && (nothing || keychainBlocked))}
              onClick={() => current && void (denied ? imp.folder(current.key) : imp.run(current.key))}>{primary}</SetupWizardStepAction>
          </Tooltip>
        </>}
    >
      {sources === null ? (
        <Inline role="status"><Spinner size={14} /><Typo.Caption tone="secondary">{text.searching}</Typo.Caption></Inline>
      ) : empty ? <EmptyLine message={text.browsersEmpty} /> : <>
        <ChoiceCardList aria-labelledby="first-run-browsers-title" role="radiogroup">
          {sources.map(source => <SourceCard key={source.key} source={source} selected={source.key === current?.key}
            disabled={imp.busy} onPick={() => setChosen(source.key)} />)}
        </ChoiceCardList>
        <BrowserImportItems flow={imp} keychain={keychain} />
        <ButtonContainer size="sm"><Button size="sm" variant="ghost" iconStart={<FileText size="sm" />}
          disabled={imp.busy || (!imp.bookmarks && !imp.passwords)} onClick={() => void imp.run("file")}>{copy.fromFile}</Button></ButtonContainer>
      </>}
      <BrowserImportFeedback flow={imp} />
    </FirstRunStepCard>
  );
}

function SourceCard({ source, selected, disabled, onPick }: { source: ImportSource; selected: boolean; disabled: boolean; onPick: () => void }) {
  const copy = appCopy.settings.browserImport;
  const brand = browserBrand(source.browser);
  const denied = source.permission === "denied";
  return <ChoiceCard role="radio" aria-checked={selected} selected={selected} chevron={false} data-import-source={source.key}
    icon={<BrandIcon browser={source.browser} />} title={brand}
    description={denied ? copy.fullDiskAccess : source.name === brand ? undefined : source.name}
    state={disabled ? "disabled" : "default"} onClick={onPick} />;
}
