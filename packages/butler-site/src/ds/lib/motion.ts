/** Reduced-motion helpers for JS-driven loops (the thinking mark), forked from the app DS. */
const QUERY = "(prefers-reduced-motion: reduce)";

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(QUERY).matches;
}

export function subscribeReducedMotion(callback: (reduced: boolean) => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const media = window.matchMedia(QUERY);
  const notify = () => callback(media.matches);
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
}
