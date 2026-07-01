import {
  initializeAppStoreKernel,
} from "./app-store-kernel-initializer.ts";
import type { AppStoreKernelState } from "./app-store-kernel-state.ts";
import type { AppServerStoreOptions } from "./app-store-options.ts";
import {
  createMessageRecordHost,
  type AppStoreKernelMessageRecordHost,
} from "../kernel-host/message-record-host.ts";
import {
  createSessionContextHost,
  type AppStoreKernelSessionContextHost,
} from "../kernel-host/session-context-host.ts";
import {
  createTurnLifecycleHost,
  type AppStoreKernelTurnLifecycleHost,
} from "../kernel-host/turn-lifecycle-host.ts";
import {
  createAppStorePublicApi,
  type AppStorePublicApi,
} from "../store-api/public-store-api.ts";

export type { AppServerStoreOptions } from "./app-store-options.ts";

type AppStoreKernelCapabilities = AppStoreKernelState &
  AppStoreKernelSessionContextHost &
  AppStoreKernelTurnLifecycleHost &
  AppStoreKernelMessageRecordHost &
  AppStorePublicApi;

export type AppStoreKernel = AppStoreKernelRuntime & AppStoreKernelCapabilities;

class AppStoreKernelRuntime {
  constructor(options: AppServerStoreOptions = {}) {
    const kernel = this as unknown as AppStoreKernel;
    Object.assign(
      this,
      createSessionContextHost(kernel),
      createTurnLifecycleHost(kernel),
      createMessageRecordHost(kernel),
    );
    Object.assign(this, createAppStorePublicApi(kernel));
    initializeAppStoreKernel(kernel, options);
  }
}

export const AppStoreKernel = AppStoreKernelRuntime as unknown as new (
  options?: AppServerStoreOptions,
) => AppStoreKernel;
