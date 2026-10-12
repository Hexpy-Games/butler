/** Read only the observed element's media source and accompanying page text. */
export async function imageSource({ ref, obs, epoch, url }) {
  const state = globalThis.__butlerObservation;
  if (!state || state.obs !== obs || state.epoch !== epoch) return { reason: "stale_ref" };
  const backgroundOf = element => getComputedStyle(element).backgroundImage.match(/^url\(["']?(.*?)["']?\)$/u)?.[1];
  const candidates = ref ? [] : [...document.images, ...document.links, ...[...state.refs.values()].map(value => value.deref()).filter(Boolean)];
  const element = ref ? state.refs.get(ref)?.deref() : candidates.find(element => element.currentSrc === url || element.src === url || element.href === url || backgroundOf(element) === url);
  if (!element?.isConnected) return { reason: ref ? "stale_ref" : "image_url_not_observed" };
  const image = element.matches("img") ? element : element.matches("picture") ? element.querySelector("img") : null;
  const background = backgroundOf(element);
  const result = { source_url: image?.currentSrc || image?.src || background || url || "",
    alt: image?.alt || element.getAttribute("aria-label") || element.textContent?.trim() || "",
    nearby_text: element.parentElement?.innerText || "" };
  // Embedded resources belong to this frame's Blob/data session, not a session HTTP fetch.
  if (!url && /^(data|blob):/u.test(result.source_url)) {
    try {
      const response = await fetch(result.source_url, { signal: AbortSignal.timeout(10000) });
      if (!response.ok || !response.headers.get("content-type")?.startsWith("image/")) return { reason: "invalid_image" };
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.length; if (size > 8 * 1024 * 1024) return { reason: "image_too_large" };
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      let text = "";
      for (const chunk of chunks) for (let i = 0; i < chunk.length; i += 8192) text += String.fromCharCode(...chunk.subarray(i, i + 8192));
      result.image = { data: btoa(text) };
      result.source_url = location.href;
    } catch { return { reason: "image_fetch_failed" }; }
  }
  return result;
}
