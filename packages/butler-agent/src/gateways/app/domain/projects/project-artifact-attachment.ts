import { createHash } from "node:crypto";
import type { ProjectDashboardDocument } from "../../interface/protocol/session-dashboard-contract.ts";
import type { AppMessageFileStore } from "../message-files/message-file-store.ts";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";

/** Copy an explicitly selected published result through the existing attachment owner.
 * Images/PDFs stay their original media type and use normal provider admission.
 */
export async function attachProjectArtifact(store: {
  getProjectDashboardSource(projectId: string, query: { kind: string; id: string; revision: string }): Promise<ProjectDashboardDocument>;
  getMessageFileDownload: AppMessageFileStore["download"];
  createMessageFile(input: Parameters<AppMessageFileStore["create"]>[0]): Promise<ReturnType<AppMessageFileStore["create"]>>;
},
  projectId: string, id: string, revision: string) {
  const source = await store.getProjectDashboardSource(projectId, { kind: "artifact", id, revision });
  if (!source.artifact?.file_id) throw new AppStoreOperationError(404, "source_unavailable", "Source unavailable.");
  const original = store.getMessageFileDownload(source.artifact.file_id);
  if (original.bytes.byteLength !== original.file.size_bytes ||
      createHash("sha256").update(original.bytes).digest("hex") !== revision) {
    throw new AppStoreOperationError(409, "source_changed", "Source changed. Reload it.");
  }
  // No source record, attachment ownership or source bytes are changed.
  return store.createMessageFile({ name: original.file.safe_name, mimeType: original.file.mime_type,
    bytes: original.bytes, allowGeneric: true });
}
