import { createContext, useContext, type ReactNode } from "react";

/** Copy for section states; the product passes app copy through `SettingsPage labels`. */
export interface SettingsSectionLabels {
  loading: string;
  error: string;
  retry: string;
  empty: string;
}

const DEFAULT_LABELS: SettingsSectionLabels = {
  loading: "Loading",
  error: "Could not load this section.",
  retry: "Retry",
  empty: "Nothing to show yet.",
};

const SettingsSectionLabelsContext = createContext<SettingsSectionLabels>(DEFAULT_LABELS);

export function SettingsSectionLabelsProvider({ labels, children }: { labels?: Partial<SettingsSectionLabels>; children: ReactNode }) {
  const parent = useContext(SettingsSectionLabelsContext);
  return (
    <SettingsSectionLabelsContext.Provider value={{ ...parent, ...labels }}>
      {children}
    </SettingsSectionLabelsContext.Provider>
  );
}

export function useSettingsSectionLabels(): SettingsSectionLabels {
  return useContext(SettingsSectionLabelsContext);
}
