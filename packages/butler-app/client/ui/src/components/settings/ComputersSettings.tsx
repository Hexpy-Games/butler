import { memo } from "react";
import { useAppLocale } from "@/app/copy.ts";
import { computersSection } from "./ComputersSection";
import { useComputersSection } from "./hooks/useComputersSection";
import { useSavedKeys } from "./hooks/useSavedKeys";
import { SettingsPage } from "./SettingsFormComponents";

export const ComputersSettings = memo(function ComputersSettings() {
  useAppLocale();
  const computersState = useComputersSection();
  const savedKeys = useSavedKeys();
  return <SettingsPage>{computersSection({ section: computersState, savedKeys: savedKeys.credentials })}</SettingsPage>;
});
