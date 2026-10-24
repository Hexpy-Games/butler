// Browser harness: actual settings components and event bus, offline gateway supplied by Playwright.
import React from "react";
import { createRoot } from "react-dom/client";
import { SettingsView } from "../../packages/butler-app/client/ui/src/components/settings/SettingsView";
import { AppToaster } from "../../packages/butler-app/client/ui/src/components/common/AppToaster";
import { AppConfirmationDialog } from "../../packages/butler-app/client/ui/src/components/common/AppConfirmationDialog";
import { EMPTY_SETTINGS } from "../../packages/butler-app/client/ui/src/app/constants";
import { HARNESS_MODEL_CATALOG } from "../../packages/butler-app/client/ui/src/app/fixtures";
import { useButlerStore } from "../../packages/butler-app/client/ui/src/app/store";
import { setAppCopyLanguage } from "../../packages/butler-app/client/ui/src/app/copy";
import { useSettingsUIStore } from "../../packages/butler-app/client/ui/src/stores/settingsUIStore";
import { publishMemoryEvent } from "../../packages/butler-app/client/ui/src/app/memoryEvents";
import "../../packages/butler-app/client/ui/src/libs/design-system/tokens.css";

const params = new URLSearchParams(location.search);
const section = params.get("page") === "models" ? "models" : "memory";
const language = params.get("locale") ?? "ko";
setAppCopyLanguage(language);
document.documentElement.className = `theme-${params.get("theme") ?? "light"}`;
const settings = { ...EMPTY_SETTINGS, language };
useButlerStore.setState({ settings, modelCatalog: HARNESS_MODEL_CATALOG, view: { kind: "settings", section } });
useSettingsUIStore.getState().initialize(settings, section);
Object.assign(window, { emitMemorySettingsEvent: publishMemoryEvent });
createRoot(document.getElementById("root")!).render(<>
  <SettingsView initialSection={section} isActive />
  <AppConfirmationDialog /><AppToaster />
</>);
