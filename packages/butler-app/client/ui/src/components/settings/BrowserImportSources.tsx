import type { ReactNode } from "react";
import { appCopy } from "@/app/copy";
import { Button, ButtonContainer, CheckIcon, EmptyLine, FieldLegend, FieldSet, FileText, Globe2, ListRow, Square, Stack, Tooltip } from "@/butler-ds";
import type { ImportSource } from "./signInsApi";
import type { useBrowserImport } from "../imports/useBrowserImport";

const BRANDS: Record<string, string> = { chrome: "Chrome", chromium: "Chromium", edge: "Edge", brave: "Brave", arc: "Arc", whale: "Whale", firefox: "Firefox", zen: "Zen", safari: "Safari" };
// Whale icon: the official favicon from shared-whale.pstatic.net (Naver trademark).

type ImportFlow = ReturnType<typeof useBrowserImport>;

function withHint(hint: string | undefined, key: string, control: ReactNode) {
  return hint ? <Tooltip key={key} label={hint}>{control}</Tooltip> : control;
}

/** What every import includes, chosen once above the sources. */
export function BrowserImportItems({ flow, keychain }: { flow: ImportFlow; keychain: boolean }) {
  const copy = appCopy.settings.browserImport;
  const items = [
    { label: copy.bookmarks, on: flow.bookmarks, set: flow.setBookmarks, hint: undefined },
    { label: copy.passwords, on: flow.passwords, set: flow.setPasswords, hint: keychain ? undefined : copy.needsKeychain },
    { label: copy.history, on: flow.history, set: flow.setHistory, hint: undefined },
  ];
  return (
    <FieldSet>
      <FieldLegend variant="label">{copy.chooseItems}</FieldLegend>
      <ButtonContainer size="sm">
        {items.map(item => withHint(item.hint, item.label,
          <Button key={item.label} size="sm" variant="ghost" role="checkbox" aria-checked={item.on} disabled={flow.busy}
            iconStart={item.on ? <CheckIcon size="sm" /> : <Square size="sm" />} onClick={() => item.set(!item.on)}>{item.label}</Button>))}
      </ButtonContainer>
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
