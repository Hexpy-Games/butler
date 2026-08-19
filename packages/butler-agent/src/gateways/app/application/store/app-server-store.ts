import { Database } from "bun:sqlite";
import {
  AppStoreKernel,
  type AppServerStoreOptions,
} from "../kernel/app-store-kernel.ts";
import {
  createLegacyStoreCompatibilityApi,
} from "../store-api/legacy-store-compatibility-api.ts";
import {
  createAppStorePublicApi,
  type AppStorePublicApi,
} from "../store-api/public-store-api.ts";

export { appRuntimePolicy } from "../../domain/runtime/app-runtime-policy.ts";
export type { DeliveryLimitationMetadata } from "../../infrastructure/transport/app-delivery-projection.ts";
export {
  AppResponderCancelledError,
  AppResponderTimeoutError,
  AppStoreOperationError,
} from "../../infrastructure/core/app-store-errors.ts";
export type {
  AppMessageResponder,
  AppMessageResponderFile,
  AppMessageResponderInput,
  AppMessageResponderResult,
  SendMessageOptions,
} from "../../domain/sessions/message-responder-contract.ts";
export { createProjectFolderSelectionToken } from "../../domain/projects/project-folder-selection-token.ts";
export type { AppServerStoreOptions } from "../kernel/app-store-kernel.ts";

type AppServerStoreCompatibilityApi = ReturnType<
  typeof createLegacyStoreCompatibilityApi
>;

export type AppServerStore = AppServerStoreRuntime &
  AppStorePublicApi &
  AppServerStoreCompatibilityApi;

class AppServerStoreRuntime {
  readonly db: Database;
  private readonly kernel: AppStoreKernel;

  constructor(options: AppServerStoreOptions) {
    this.kernel = new AppStoreKernel(options);
    this.db = this.kernel.db;
    Object.assign(
      this,
      createAppStorePublicApi(this.kernel),
      createLegacyStoreCompatibilityApi(this.kernel),
    );
  }
}

export const AppServerStore = AppServerStoreRuntime as unknown as new (
  options: AppServerStoreOptions,
) => AppServerStore;
