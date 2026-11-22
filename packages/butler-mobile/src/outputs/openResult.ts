import { router } from "expo-router";
import { showToast } from "@/ds";
import { openImage } from "./fileAccess";
import { viewerParams, type ResultTarget } from "./results";

export function openResult(target: ResultTarget, pairing: { origin: string; deviceToken: string }, loadFailed: string) {
  if (target.kind === "image") {
    void openImage(pairing, target.path, target.title).catch(() => showToast({ message: loadFailed, tone: "error" }));
  } else router.push({ pathname: "/viewer", params: viewerParams(target) });
}
