import { useEffect, useRef, useState } from "react";
import {
  Clock3,
  CommandPalettePanel,
  Folder,
  PencilLine,
  Settings,
} from "@/butler-ds";
import { api } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import type { CommandPaletteResult } from "@/app/types.ts";

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
  const [results, setResults] = useState<CommandPaletteResult[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function search() {
      const data = await api<{ results: CommandPaletteResult[] }>(
        `/command-palette?query=${encodeURIComponent(query)}`,
      );
      if (!cancelled) setResults(data.results ?? []);
    }
    const timer = setTimeout(search, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  return (
    <CommandPalettePanel
      label={appCopy.commandPalette.label}
      closeLabel={appCopy.commandPalette.close}
      inputRef={inputRef}
      query={query}
      placeholder={appCopy.commandPalette.placeholder}
      onClose={close}
      onQueryChange={setQuery}
      items={results.map((result) => ({
        id: `${result.kind}-${result.id}`,
        title: result.title,
        subtitle: result.subtitle,
        icon: <CommandIcon kind={result.kind} />,
        onSelect: () => select(result),
      }))}
    />
  );
}

function CommandIcon({ kind }: { kind: CommandPaletteResult["kind"] }) {
  if (kind === "automation") return <Clock3 size={17} />;
  if (kind === "project" || kind === "project_session")
    return <Folder size={17} />;
  if (kind === "settings") return <Settings size={17} />;
  return <PencilLine size={17} />;
}
