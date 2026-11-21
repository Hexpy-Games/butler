import { createContext, useContext, useSyncExternalStore } from "react";
import { Platform } from "react-native";

const TextSelection = createContext(true);

/** Lets a list turn `selectable` off for the DS text inside while a row is not at rest. Default: on. */
export function TextSelectionScope({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  return <TextSelection.Provider value={enabled}>{children}</TextSelection.Provider>;
}

export function useTextSelectionEnabled(): boolean {
  return useContext(TextSelection);
}

export const SelectableRowsContext = createContext<{ subscribe(listener: () => void): () => void; has(id: string): boolean } | null>(null);

const noop = () => () => {};
/** True when this row's text may be selectable: always on Android and outside a chat list. */
export function useSelectableRow(id: string): boolean {
  const rows = useContext(SelectableRowsContext);
  const on = useSyncExternalStore(rows?.subscribe ?? noop, () => !rows || rows.has(id));
  return Platform.OS !== "ios" || on;
}
