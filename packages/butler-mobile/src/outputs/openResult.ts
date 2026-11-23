import { router } from "expo-router";
import type { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { shareImage } from "@/conversation/imageActions";
import { showToast } from "@/ds";
import { openImage } from "./fileAccess";
import { viewerParams, type ResultTarget } from "./results";

type Copy = ReturnType<typeof getAppCopy>;

export function openResult(target: ResultTarget, pairing: { origin: string; deviceToken: string }, loadFailed: string, copy: Copy) {
  if (target.kind === "image") {
    void openImage(pairing, target.path, target.title, target.name ? shareImage(pairing, target.path, target.name, target.title, copy) : undefined)
      .catch(() => showToast({ message: loadFailed, tone: "error" }));
  } else router.push({ pathname: "/viewer", params: viewerParams(target) });
}
