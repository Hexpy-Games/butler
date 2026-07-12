import { useEffect } from "react";
import { normalizeSettingsSectionId } from "@/app/utils.ts";
import type { AppView, SettingsSectionId } from "@/app/types.ts";

export function useCompactSettingsPaneEntry({
  initialSection,
  isActive,
  setCompactPane,
  view,
}: {
  initialSection?: SettingsSectionId | string;
  isActive: boolean;
  setCompactPane: (pane: "master" | "detail") => void;
  view: AppView;
}) {
  useEffect(() => {
    if (!isActive) return;
    const section =
      view.kind === "settings"
        ? view.section
        : (initialSection ?? "general");
    if (normalizeSettingsSectionId(section) !== "general") {
      setCompactPane("detail");
    }
  }, [initialSection, isActive, setCompactPane, view]);
}
