import { useAppLocale } from "@/app/copy.ts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Briefcase,
  Clock3,
  CommandPalettePanel,
  Folder,
  Notebook,
  PencilLine,
  Settings,
  Button,
  Notice,
  Typo,
} from "@/butler-ds";
import { api } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import type { CommandPaletteResult } from "@/app/types.ts";
import { useOrganization } from "@/app/space/organization";
import { commandResultSubtitle, commandResultTitle } from "./commandPaletteLabels";
import { useCommandPaletteFocus } from "./useCommandPaletteFocus";

export function CommandPalette({
  open = true,
  onClose,
  onSelect,
}: {
  /** The app shell keeps the palette mounted and toggles this so it can animate out. */
  open?: boolean;
  onClose?: () => void;
  onSelect?: (result: CommandPaletteResult) => void;
} = {}) {
  useAppLocale();
  const setCommandOpen = useButlerStore((state) => state.setCommandOpen);
  const navigateCommandResult = useButlerStore(
    (state) => state.navigateCommandResult,
  );
  const close = onClose ?? (() => setCommandOpen(false));
  const select = onSelect ?? navigateCommandResult;
  const [query, setQuery] = useState("");
  const [searchState, setSearchState] = useState<{
    query: string; status: "loading" | "ready" | "error"; results: CommandPaletteResult[];
  }>({ query: "", status: "loading", results: [] });
  const [retry, setRetry] = useState(0);
  const status = searchState.query === query ? searchState.status : "loading";
  const results = status === "ready" ? searchState.results : [];
  const inputRef = useRef<HTMLInputElement | null>(null);
  useCommandPaletteFocus(open, inputRef, () => setQuery(""));

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSearchState({ query, status: "loading", results: [] });
    async function search() {
      try {
        const data = await api<{ results: CommandPaletteResult[] }>(
          `/command-palette?query=${encodeURIComponent(query)}`,
        );
        if (!cancelled) setSearchState({ query, status: "ready", results: data.results ?? [] });
      } catch {
        if (!cancelled) setSearchState({ query, status: "error", results: [] });
      }
    }
    const timer = setTimeout(search, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, retry, open]);

  return (
    <CommandPalettePanel
      open={open}
      label={appCopy.commandPalette.label}
      closeLabel={appCopy.commandPalette.close}
      inputRef={inputRef}
      query={query}
      placeholder={appCopy.commandPalette.placeholder}
      onClose={close}
      onQueryChange={setQuery}
      feedback={status === "error" ? (
        <Notice tone="error" message={appCopy.commandPalette.failed}
          action={<Button variant="outline" size="sm" onClick={() => setRetry((value) => value + 1)}>
            {appCopy.feedback.retry}
          </Button>} />
      ) : status === "loading" || results.length === 0 ? (
        <Typo.Caption>{status === "loading" ? appCopy.commandPalette.loading : appCopy.commandPalette.empty}</Typo.Caption>
      ) : undefined}
      items={results.map((result) => ({
        id: `${result.kind}-${result.id}`,
        title: highlightMatch(commandResultTitle(result), query),
        subtitle: commandResultSubtitle(result),
        icon: <CommandIcon kind={result.kind} />,
        onSelect: () => {
          if (result.kind === "group") { useOrganization.getState().reveal(`g:${result.id}`); close(); }
          else select(result);
        },
      }))}
    />
  );
}

function CommandIcon({ kind }: { kind: CommandPaletteResult["kind"] }) {
  useAppLocale();
  if (kind === "automation") return <Clock3 size="md" />;
  if (kind === "project") return <Briefcase size="md" />;
  if (kind === "project_session") return <Notebook size="md" />;
  if (kind === "group") return <Folder size="md" />;
  if (kind === "settings") return <Settings size="md" />;
  return <PencilLine size="md" />;
}

function highlightMatch(title: string, query: string): ReactNode {
  const needle = query.trim().toLocaleLowerCase();
  const start = needle ? title.toLocaleLowerCase().indexOf(needle) : -1;
  if (start < 0) return title;
  const end = start + needle.length;
  return (
    <>
      {title.slice(0, start)}
      <mark>{title.slice(start, end)}</mark>
      {title.slice(end)}
    </>
  );
}
