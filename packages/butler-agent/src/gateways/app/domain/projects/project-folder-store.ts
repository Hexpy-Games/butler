import {
  accessSync,
  constants as fsConstants,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";
import { isSensitiveProjectFolder } from "../../infrastructure/core/path-safety.ts";

const SCRATCH_PROJECT_BASE_NAME = "New project";

export class AppProjectFolderStore {
  constructor(private readonly projectWorkspaceRoot: () => string) {}

  createScratchProjectFolder(): string {
    try {
      mkdirSync(this.projectWorkspaceRoot(), { recursive: true });
    } catch {
      throw new AppStoreOperationError(
        400,
        "project_workspace_unavailable",
        "Project workspace is not available.",
      );
    }
    const root = realpathSync(this.projectWorkspaceRoot());
    for (let index = 1; index < 1000; index += 1) {
      const folderName =
        index === 1
          ? SCRATCH_PROJECT_BASE_NAME
          : `${SCRATCH_PROJECT_BASE_NAME} ${index}`;
      const candidate = resolve(root, folderName);
      try {
        mkdirSync(candidate);
        return realpathSync(candidate);
      } catch (error) {
        if (isNodeError(error) && error.code === "EEXIST") continue;
        throw new AppStoreOperationError(
          400,
          "project_folder_unavailable",
          "Project folder could not be created.",
        );
      }
    }
    throw new AppStoreOperationError(
      409,
      "project_folder_name_exhausted",
      "Project folder name is unavailable.",
    );
  }

  validateProjectFolder(folderPath: string): string {
    const workspacePath = resolve(folderPath);
    try {
      const stat = statSync(workspacePath);
      if (!stat.isDirectory()) {
        throw new AppStoreOperationError(
          400,
          "project_folder_invalid",
          "Project folder must be a directory.",
        );
      }
      accessSync(workspacePath, fsConstants.R_OK);
      const realWorkspacePath = realpathSync(workspacePath);
      if (isSensitiveProjectFolder(realWorkspacePath)) {
        throw new AppStoreOperationError(
          400,
          "project_folder_unsafe",
          "Project folder is not safe to use.",
        );
      }
      return realWorkspacePath;
    } catch (error) {
      if (error instanceof AppStoreOperationError) throw error;
      throw new AppStoreOperationError(
        400,
        "project_folder_invalid",
        "Project folder is not available.",
      );
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
