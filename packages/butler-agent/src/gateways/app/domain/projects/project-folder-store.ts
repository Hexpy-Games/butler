import {
  accessSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  realpathSync,
  readdirSync,
  rmdirSync,
  statSync,
} from "node:fs";
import { relative, resolve, sep } from "node:path";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";
import { isSensitiveProjectFolder } from "../../infrastructure/core/path-safety.ts";

const MAX_SCRATCH_PROJECT_NAME_CODE_POINTS = 80;
const MAX_SCRATCH_PROJECT_ATTEMPTS = 10_000;
const WINDOWS_RESERVED_STEMS = new Set(["con", "prn", "aux", "nul"]);
const PORTABLE_INVALID_CHARACTERS = new Set([
  "/",
  "\\",
  "<",
  ">",
  ":",
  '"',
  "|",
  "?",
  "*",
]);

export function validateScratchProjectName(value: string | undefined): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AppStoreOperationError(
      400,
      "project_name_required",
      "Project name is required.",
    );
  }
  if (value.trim() !== value || value.length === 0) {
    throw new AppStoreOperationError(
      400,
      "project_name_invalid",
      "Project name must be trimmed.",
    );
  }
  if ([...value].length > MAX_SCRATCH_PROJECT_NAME_CODE_POINTS) {
    throw new AppStoreOperationError(
      400,
      "project_name_invalid",
      "Project name must be at most 80 characters.",
    );
  }
  if (
    value === "." ||
    value === ".." ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        codePoint <= 0x1f ||
        codePoint === 0x7f ||
        PORTABLE_INVALID_CHARACTERS.has(character)
      );
    }) ||
    value.endsWith(".") ||
    value.endsWith(" ")
  ) {
    throw new AppStoreOperationError(
      400,
      "project_name_invalid",
      "Project name is not a safe folder name.",
    );
  }
  const reservedStem = value.split(".", 1)[0]!.toLocaleLowerCase("en-US");
  if (
    WINDOWS_RESERVED_STEMS.has(reservedStem) ||
    /^(?:com|lpt)[1-9]$/u.test(reservedStem)
  ) {
    throw new AppStoreOperationError(
      400,
      "project_name_invalid",
      "Project name is reserved by Windows.",
    );
  }
  return value;
}

export interface ScratchProjectFolder {
  path: string;
  device: number;
  inode: number;
}

export class AppProjectFolderStore {
  constructor(private readonly projectWorkspaceRoot: () => string) {}

  createScratchProjectFolder(displayName: string): ScratchProjectFolder {
    const safeDisplayName = validateScratchProjectName(displayName);
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
    for (let index = 1; index <= MAX_SCRATCH_PROJECT_ATTEMPTS; index += 1) {
      const folderName =
        index === 1 ? safeDisplayName : `${safeDisplayName} ${index}`;
      const candidate = resolve(root, folderName);
      if (!isPathInsideRoot(root, candidate) || candidate === root) {
        throw new AppStoreOperationError(
          400,
          "project_folder_unsafe",
          "Project folder is not safe to use.",
        );
      }
      try {
        mkdirSync(candidate);
        const createdPath = realpathSync(candidate);
        if (!isPathInsideRoot(root, createdPath) || createdPath === root) {
          throw new AppStoreOperationError(
            400,
            "project_folder_unsafe",
            "Project folder is not safe to use.",
          );
        }
        const identity = lstatSync(createdPath);
        return {
          path: createdPath,
          device: identity.dev,
          inode: identity.ino,
        };
      } catch (error) {
        if (error instanceof AppStoreOperationError) throw error;
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

  removeScratchProjectFolder(folder: ScratchProjectFolder): void {
    try {
      const root = realpathSync(this.projectWorkspaceRoot());
      const candidate = resolve(folder.path);
      if (!isPathInsideRoot(root, candidate) || candidate === root) return;
      const identity = lstatSync(candidate);
      if (
        !identity.isDirectory() ||
        identity.dev !== folder.device ||
        identity.ino !== folder.inode ||
        readdirSync(candidate).length > 0
      ) {
        return;
      }
      rmdirSync(candidate);
    } catch {
      // Rollback is best effort and must never remove a non-empty or replaced path.
    }
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

function isPathInsideRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot.length > 0 &&
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !pathFromRoot.startsWith(sep)
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
