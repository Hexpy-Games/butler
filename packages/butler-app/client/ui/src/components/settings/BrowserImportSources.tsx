import type { ReactNode } from "react";
import { appCopy } from "@/app/copy";
import {
  Bookmark, Button, ButtonContainer, CheckCard, CheckCardList, EmptyLine, FieldLegend, FieldSet, FileText, Globe2, History, Key, ListRow, Stack,
  Tooltip,
} from "@/butler-ds";
import type { ImportSource } from "./signInsApi";
import type { useBrowserImport } from "../imports/useBrowserImport";

const BRANDS: Record<string, string> = { chrome: "Chrome", chromium: "Chromium", edge: "Edge", brave: "Brave", arc: "Arc", whale: "Whale", firefox: "Firefox", zen: "Zen", safari: "Safari" };
// Whale icon: the official favicon from shared-whale.pstatic.net (Naver trademark).

type ImportFlow = ReturnType<typeof useBrowserImport>;

function withHint(hint: string | undefined, key: string, control: ReactNode) {
  return hint ? <Tooltip key={key} label={hint}>{control}</Tooltip> : control;
}

/** What every import includes, chosen once above the sources: multi-select check cards (DS CheckCard). */
export function BrowserImportItems({ flow, keychain }: { flow: ImportFlow; keychain: boolean }) {
  const copy = appCopy.settings.browserImport;
  const items = [
    { id: "bookmarks", label: copy.bookmarks, icon: <Bookmark size="md" />, on: flow.bookmarks, set: flow.setBookmarks, hint: undefined },
    { id: "passwords", label: copy.passwords, icon: <Key size="md" />, on: flow.passwords, set: flow.setPasswords, hint: keychain ? undefined : copy.needsKeychain },
    { id: "history", label: copy.history, icon: <History size="md" />, on: flow.history, set: flow.setHistory, hint: undefined },
  ];
  return (
    <FieldSet>
      <FieldLegend variant="label" id="browser-import-items">{copy.chooseItems}</FieldLegend>
      <CheckCardList aria-labelledby="browser-import-items">
        {items.map(item => (
          <CheckCard key={item.id} data-browser-import-item={item.id} icon={item.icon} title={item.label} description={item.hint}
            checked={item.on} disabled={flow.busy} onCheckedChange={item.set} />
        ))}
      </CheckCardList>
    </FieldSet>
  );
}

/** Brand name of a detected browser; unknown browsers keep their own id. */
export function browserBrand(browser: string): string {
  return BRANDS[browser] ?? browser;
}

export function BrandIcon({ browser }: { browser: string }) {
  if (!BRANDS[browser]) return <Globe2 size="md" />;
  return <img src={`/browser-icons/${browser}.${browser === "whale" ? "png" : "svg"}`} width={20} height={20} alt="" />;
}

/** One detected profile: brand, profile name and its own import action. */
function SourceRow({ source, flow, blocked, hint }: { source: ImportSource; flow: ImportFlow; blocked: boolean; hint?: string }) {
  const copy = appCopy.settings.browserImport;
  const brand = browserBrand(source.browser);
  const denied = source.permission === "denied";
  const profile = denied ? copy.fullDiskAccess : source.name === brand ? undefined : source.name;
  const action = denied ? copy.pickFolder : copy.run;
  return (
    <Stack align="row" cross="center" gap="sm" data-import-source={source.key}>
      <Stack grow minWidth="0"><ListRow icon={<BrandIcon browser={source.browser} />} title={brand} description={profile} /></Stack>
      {withHint(hint, source.key, <Button size="sm" variant="outline" disabled={blocked} aria-label={`${action} · ${brand}${denied || !profile ? "" : ` · ${profile}`}`}
        onClick={() => void flow.run(source.key)}>{action}</Button>)}
    </Stack>
  );
}

/** Detected browsers as rows, an honest empty line, then file import as a secondary action. */
export function BrowserImportSources({ flow, keychain, blocked }: { flow: ImportFlow; keychain: boolean; blocked: boolean }) {
  const copy = appCopy.settings.browserImport;
  const hint = !keychain && flow.passwords ? copy.needsKeychain : undefined;
  return (
    <>
      {flow.sources?.length
        ? flow.sources.map(source => <SourceRow key={source.key} source={source} flow={flow} blocked={blocked} hint={hint} />)
        : <EmptyLine message={copy.noSources} />}
      <ButtonContainer size="sm">
        {withHint(hint, "file", <Button size="sm" variant="ghost" iconStart={<FileText size="sm" />}
          disabled={blocked || (!flow.bookmarks && !flow.passwords)} onClick={() => void flow.run("file")}>{copy.fromFile}</Button>)}
      </ButtonContainer>
    </>
  );
}

/** The imported profile and what came over, as a row (first-line aligned, no undo). */
export function ImportedProfile({ flow }: { flow: ImportFlow }) {
  const copy = appCopy.settings.browserImport;
  const result = flow.result!;
  const source = flow.sources?.find(entry => entry.key === flow.selected);
  const brand = source ? browserBrand(source.browser) : copy.fromFile;
  return <ListRow icon={source ? <BrandIcon browser={source.browser} /> : <FileText size="md" />}
    title={source && source.name !== brand ? `${brand} · ${source.name}` : brand}
    description={copy.result(result.bookmarks, result.passwords, result.updated, result.history ?? 0, result.invalid ?? 0)} />;
}
