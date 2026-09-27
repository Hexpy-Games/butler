import { createContext, useContext, type ReactNode } from "react";

/** The section a settings field belongs to (`SettingsSection`, `FormSection` or `DialogForm`). */
export interface SettingsFieldScope {
  sectionId?: string;
}

const SettingsFieldScopeContext = createContext<SettingsFieldScope | null>(null);

export function SettingsFieldScopeProvider({ sectionId, children }: SettingsFieldScope & { children: ReactNode }) {
  return <SettingsFieldScopeContext.Provider value={{ sectionId }}>{children}</SettingsFieldScopeContext.Provider>;
}

export function useSettingsFieldScope(): SettingsFieldScope | null {
  return useContext(SettingsFieldScopeContext);
}
