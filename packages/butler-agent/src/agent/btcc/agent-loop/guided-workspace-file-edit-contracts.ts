import type { GuidedWorkspaceEditGuardOptions } from "./guided-workspace-file-edit-observation.ts";
import type { GuidedWorkspaceFileEditBatchInput } from "./guided-workspace-file-edit-batch.ts";
import type { ChangedFileDetail } from "../../tools/file-tools/shared/changed-file-detail.ts";

export const GUIDED_WORKSPACE_FILE_EDIT_CAPABILITY = "edit_file";

export type GuidedWorkspaceFileEditInput = {
  path: string;
  start_line: number;
  old_text: string;
  new_text: string;
  before_sha256: string;
  after_sha256: string;
};

export type GuidedWorkspaceFileEditBatch = GuidedWorkspaceFileEditBatchInput;

export type GuidedWorkspaceFileEditResult = {
  ok: true;
  effect: "workspace_file_edit";
  path: string;
  start_line: number;
  bytes: number;
  before_sha256: string;
  after_sha256: string;
  target_observed: true;
  changed_file?: ChangedFileDetail;
};

export type GuidedWorkspaceFileEditBatchResult = {
  ok: true;
  effect: "workspace_file_edit_batch";
  files: number;
  bytes: number;
  entries: readonly {
    index: number;
    start_line: number;
    bytes: number;
    before_sha256: string;
    after_sha256: string;
  }[];
  target_observed: true;
  changed_files?: ChangedFileDetail[];
};

export type RegisteredEditFileInput = {
  path: string;
  start_line: number;
  old_text: string;
  new_text: string;
  expected_sha256: string;
};

export type RegisteredEditFileBatchInput = {
  edits: readonly {
    path: string;
    start_line: number;
    old_text: string;
    new_text: string;
    expected_sha256: string;
  }[];
};

export type RegisteredEditFileInvocation =
  | RegisteredEditFileInput
  | RegisteredEditFileBatchInput;

export type GuidedWorkspaceFileEditAdapterOptions =
  GuidedWorkspaceEditGuardOptions & {
    executeEditFile(input: RegisteredEditFileInvocation): Promise<unknown>;
  };
