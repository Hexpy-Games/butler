import { useSyncExternalStore } from "react";

/** True while this window is shown and focused: what is on screen is being seen. */
function attended(): boolean {
  if (typeof document === "undefined") return false;
  return document.visibilityState === "visible" && document.hasFocus();
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("focus", onChange);
  window.addEventListener("blur", onChange);
  document.addEventListener("visibilitychange", onChange);
  return () => {
    window.removeEventListener("focus", onChange);
    window.removeEventListener("blur", onChange);
    document.removeEventListener("visibilitychange", onChange);
  };
}

export function useDocumentAttended(): boolean {
  return useSyncExternalStore(subscribe, attended, () => false);
}
