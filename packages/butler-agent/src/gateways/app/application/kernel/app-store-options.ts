import type { SettingsView } from "../../interface/protocol/app-protocol.ts";
import type { ButlerServiceClient } from "../../../core/client.ts";
import type { ConversationProjectionReader } from "../../../../agent/conversation/types.ts";
import type { SessionBindingStore } from
  "../../../../test-support/harness/session-store.ts";
import type { ProviderQuotaMonitor } from "../../../../operations/metrics/provider-quota.ts";

export const DEFAULT_CHAT_ID = "general";
export const DEFAULT_CHAT_TITLE = "Onboarding";
export const DEFAULT_APP_UPDATE_MANIFEST =
  "https://github.com/Hexpy-Games/butler/releases/latest/download/app-update-manifest.json";

export interface AppServerStoreOptions {
  dbPath?: string;
  projectWorkspaceRoot?: string;
  folderSelectionSecret?: string;
  butlerData?: string;
  butlerHome?: string;
  appVersion?: string;
  appUpdateManifest?: string;
  serverUrl?: string;
  bridgeMode?: SettingsView["bridge_mode"];
  serviceClient?: ButlerServiceClient;
  conversationProjectionReader?: ConversationProjectionReader;
  sessionBindingStore?: SessionBindingStore;
  providerQuotaMonitor?: ProviderQuotaMonitor;
}
