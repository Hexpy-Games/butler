import type { AppStoreKernel } from "../kernel/app-store-kernel.ts";
import {
  createAutomationWorkerStoreApi,
  type AppStoreAutomationWorkerApi,
} from "./automation-worker-store-api.ts";
import {
  createNavigationProjectStoreApi,
  type AppStoreNavigationProjectApi,
} from "./navigation-project-store-api.ts";
import {
  createRuntimeStoreApi,
  type AppStoreRuntimeApi,
} from "./runtime-store-api.ts";
import {
  createSessionStoreApi,
  type AppStoreSessionApi,
} from "./session-store-api.ts";
import {
  createSettingsStoreApi,
  type AppStoreSettingsApi,
} from "./settings-store-api.ts";

export interface AppStorePublicApi
  extends AppStoreRuntimeApi,
    AppStoreNavigationProjectApi,
    AppStoreSettingsApi,
    AppStoreAutomationWorkerApi,
    AppStoreSessionApi {}

export function createAppStorePublicApi(
  kernel: AppStoreKernel,
): AppStorePublicApi {
  return Object.assign(
    {},
    createRuntimeStoreApi(kernel),
    createNavigationProjectStoreApi(kernel),
    createSettingsStoreApi(kernel),
    createAutomationWorkerStoreApi(kernel),
    createSessionStoreApi(kernel),
  );
}
