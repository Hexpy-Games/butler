import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import type { GatewayClient } from "../../../butler-protocol/src/client/index.ts";
import type { Access } from "@/connection/access";
import { showToast } from "@/ds";
import { shareFile } from "@/outputs/fileAccess";
import { uuid } from "@/settings/format";

type Copy = ReturnType<typeof getAppCopy>;

/** Share sheet for an image the gateway serves at `path` (the OS offers Save Image there). */
export function shareImage(access: Access, path: string, name: string, title: string, copy: Copy): () => void {
  return () => { void shareFile(access, path, name, title).catch(() => showToast({ message: copy.mobile.outputs.shareFailed, tone: "error" })); };
}

/** Saves a generated image to the 서랍, like desktop's GeneratedImageActions. */
export function saveImage(client: GatewayClient, asset: string, session: string | undefined, title: string, copy: Copy): () => void {
  return () => {
    void client.request("/library", { method: "POST", body: { id: uuid(), kind: "scrap", title, url: "", asset, text: "", ...(session ? { session } : {}), capturedAt: new Date().toISOString() } })
      .then(() => showToast({ message: copy.mobile.outputs.savedToLibrary }), () => showToast({ message: copy.mobile.outputs.saveFailed, tone: "error" }));
  };
}
