import type { ReactNode } from "react";
import { appCopy } from "@/app/copy";
import {
  Bookmark, CheckCard, CheckCardList, ChoiceCard, ChoiceCardList, EmptyLine, FieldLegend, FieldSet, FileText, Globe2, History, Key, ListRow,
} from "@/butler-ds";
import type { useBrowserImport } from "../imports/useBrowserImport";

const BRANDS: Record<string, string> = { chrome: "Chrome", chromium: "Chromium", edge: "Edge", brave: "Brave", arc: "Arc", whale: "Whale", firefox: "Firefox", zen: "Zen", safari: "Safari" };
// Whale icon: the official favicon from shared-whale.pstatic.net (Naver trademark).

/** Import from exported files instead of a detected profile. */
export const FILE_SOURCE = "file";

type ImportFlow = ReturnType<typeof useBrowserImport>;

/** The item kinds a source can bring over: files carry bookmarks and passwords only. */
export function importItems(flow: ImportFlow, source: string) {
  const copy = appCopy.settings.browserImport;
  const items = [
    { id: "bookmarks", label: copy.bookmarks, icon: <Bookmark size="md" />, on: flow.bookmarks, set: flow.setBookmarks },
    { id: "passwords", label: copy.passwords, icon: <Key size="md" />, on: flow.passwords, set: flow.setPasswords },
    { id: "history", label: copy.history, icon: <History size="md" />, on: flow.history, set: flow.setHistory },
  ];
  return source === FILE_SOURCE ? items.filter(item => item.id !== "history") : items;
}

/** Step 2: what this import includes, as multi-select check cards (DS CheckCard). */
export function BrowserImportItems({ flow, keychain, source }: { flow: ImportFlow; keychain: boolean; source: string }) {
  const copy = appCopy.settings.browserImport;
  return (
    <FieldSet>
      <FieldLegend variant="label" id="browser-import-items">{copy.chooseItems}</FieldLegend>
      <CheckCardList aria-labelledby="browser-import-items">
        {importItems(flow, source).map(item => (
          <CheckCard key={item.id} data-browser-import-item={item.id} icon={item.icon} title={item.label}
            description={item.id === "passwords" && !keychain ? copy.needsKeychain : undefined}
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

/** A source's icon, brand and profile name (none when the profile is the brand, as Safari's is). */
export function describeSource(flow: ImportFlow, key: string): { icon: ReactNode; brand: string; profile?: string; denied: boolean } {
  const copy = appCopy.settings.browserImport;
  const source = flow.sources?.find(entry => entry.key === key);
  if (!source) return { icon: <FileText size="md" />, brand: copy.fromFile, profile: `${copy.htmlFile} · ${copy.csvFile}`, denied: false };
  const brand = browserBrand(source.browser);
  return { icon: <BrandIcon browser={source.browser} />, brand, profile: source.name === brand ? undefined : source.name, denied: source.permission === "denied" };
}

/** Step 1: detected profiles as radio cards, an honest empty line, then file import as the last choice. */
export function BrowserChoices({ flow, choice, onChoose }: { flow: ImportFlow; choice: string | null; onChoose: (key: string) => void }) {
  const copy = appCopy.settings.browserImport;
  const keys = [...(flow.sources ?? []).map(source => source.key), FILE_SOURCE];
  const card = (key: string): ReactNode => {
    const view = describeSource(flow, key);
    return <ChoiceCard key={key} role="radio" aria-checked={choice === key} selected={choice === key} chevron={false}
      data-import-source={key} icon={view.icon} title={view.brand} description={view.denied ? copy.fullDiskAccess : view.profile}
      onClick={() => onChoose(key)} />;
  };
  return <>
    {flow.sources?.length ? null : <EmptyLine message={copy.noSources} />}
    <ChoiceCardList role="radiogroup" aria-label={copy.chooseBrowser}>{keys.map(card)}</ChoiceCardList>
  </>;
}

/** The chosen source on top of steps 2 and 3: two lines before the import, one line with the result after. */
export function ChosenSource({ flow, source, detail }: { flow: ImportFlow; source: string; detail?: string }) {
  const view = describeSource(flow, source);
  if (detail === undefined) return <ListRow icon={view.icon} title={view.brand} description={view.profile} />;
  const title = view.profile && source !== FILE_SOURCE ? `${view.brand} · ${view.profile}` : view.brand;
  return <ListRow icon={view.icon} title={title} description={detail} />;
}
