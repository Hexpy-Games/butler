import { useEffect, useRef, useState } from "react";
import {
  Clock3,
  CommandPalettePanel,
  Folder,
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

export function CommandPalette({
  onClose,
  onSelect,
}: {
  onClose?: () => void;
  onSelect?: (result: CommandPaletteResult) => void;
} = {}) {
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

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
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
  }, [query, retry]);

  return (
    <CommandPalettePanel
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
        title: result.title,
        subtitle: result.subtitle,
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
  if (kind === "automation") return <Clock3 size={17} />;
  if (kind === "project" || kind === "project_session" || kind === "group")
    return <Folder size={17} />;
  if (kind === "settings") return <Settings size={17} />;
  return <PencilLine size={17} />;
}
