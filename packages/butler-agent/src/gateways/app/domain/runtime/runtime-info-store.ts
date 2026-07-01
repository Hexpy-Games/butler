import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyComponentUpdate,
  checkComponentUpdates,
} from "../../../../operations/update/component-updater.ts";
import { APP_PROTOCOL_VERSION } from "../../interface/protocol/app-protocol.ts";
import type {
  AppInfoView,
  UpdateApplyRequest,
  UpdateApplyResult,
  UpdateCheckRequest,
  UpdateStatusView,
} from "../../interface/protocol/app-protocol.ts";

const APP_REPOSITORY_URL = "https://github.com/Hexpy-Games/butler";

export class AppRuntimeInfoStore {
  constructor(
    private readonly butlerHome: string,
    private readonly butlerData: string,
    private readonly appVersion: string | undefined,
    private readonly appUpdateManifest: string,
    private readonly defaultAppName = "Butler",
  ) {}

  async getUpdateStatus(): Promise<UpdateStatusView> {
    return await checkComponentUpdates({
      root: this.butlerHome,
      butlerData: this.butlerData,
      appVersion: this.appVersion,
      manifestPath: this.appUpdateManifest,
      components: ["app"],
    });
  }

  async checkUpdates(
    request: UpdateCheckRequest = {},
  ): Promise<UpdateStatusView> {
    const components =
      request.components ??
      (request.component ? [request.component] : undefined);
    return await checkComponentUpdates({
      root: this.butlerHome,
      butlerData: this.butlerData,
      appVersion: this.appVersion,
      manifestPath: this.appUpdateManifest,
      components,
      channel: request.channel,
    });
  }

  async applyUpdate(request: UpdateApplyRequest): Promise<UpdateApplyResult> {
    return await applyComponentUpdate({
      root: this.butlerHome,
      butlerData: this.butlerData,
      appVersion: this.appVersion,
      component: request.component,
      manifestPath: this.appUpdateManifest,
      channel: request.channel,
      dryRun: request.dry_run,
    });
  }

  getAppInfo(): AppInfoView {
    const pkg = safeObject(
      readJsonFile(
        join(
          this.butlerHome,
          "packages",
          "butler-app",
          "client",
          "electron",
          "package.json",
        ),
      ),
    );
    return {
      name: safeString(pkg.productName) || this.defaultAppName,
      version: safeString(pkg.version) || "0.0.0",
      repository_url: APP_REPOSITORY_URL,
      protocol_version: APP_PROTOCOL_VERSION,
      developer_mode_available: false,
      developer_mode_enabled: false,
    };
  }
}

function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function safeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
