import { largestRendition } from "./image-renditions.mjs";

/** Read only the observed element's media source and accompanying page text. */
export async function imageSource({ ref, obs, epoch, url }) {
  const state = globalThis.__butlerObservation;
  if (ref && (!state || state.obs !== obs || state.epoch !== epoch)) return { reason: "stale_ref" };
  const requestContext = (element, source = url) => {
    const policy = element?.referrerPolicy || document.referrerPolicy;
    let referer = policy === "no-referrer" ? "" : /^(origin|strict-origin)$/u.test(policy) ? `${location.origin}/` : location.href;
    try { if (policy === "same-origin" && new URL(source, location.href).origin !== location.origin) referer = ""; }
    catch { referer = ""; }
    return { referer, user_agent: navigator.userAgent };
  };
  const backgroundOf = element => getComputedStyle(element).backgroundImage.match(/^url\(["']?(.*?)["']?\)$/u)?.[1];
  const candidates = ref ? [] : [...document.images, ...document.links, ...[...state?.refs?.values() ?? []].map(value => value.deref()).filter(Boolean)];
  const element = ref ? state.refs.get(ref)?.deref() : candidates.find(element => element.currentSrc === url || element.src === url || element.href === url || backgroundOf(element) === url);
  if (!element?.isConnected) return ref ? { reason: "stale_ref" } : { source_url: url, alt: "", nearby_text: "", ...requestContext(element) };
  const image = element.matches("img") ? element : element.matches("picture") ? element.querySelector("img") : null;
  const background = backgroundOf(element);
  const result = { source_url: url ?? (image?.currentSrc || image?.src || background || ""),
    alt: image?.alt || element.getAttribute("aria-label") || element.textContent?.trim() || "",
    nearby_text: element.parentElement?.innerText || "" };
  // Unavailable page pixels leave URL fetching and address checks to the gateway.
  if (url && (!image || !image.complete || !image.naturalWidth)) return { ...result, ...requestContext(image || element) };
  let pixels = image;
  if (!pixels && background) {
    pixels = new Image();
    pixels.src = background;
  }
  if (image && !image.currentSrc && image.dataset.src) {
    pixels = new Image();
    pixels.src = image.dataset.src;
    result.source_url = pixels.src;
  }
  if (!pixels) return { ...result, capture_element: true };
  const selected = await largestRendition(image, pixels);
  if (selected !== pixels) result.source_url = selected.src;
  pixels = selected;
  let timer;
  try {
    if (!pixels.complete || !pixels.naturalWidth) {
      await Promise.race([pixels.decode(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), 10000); })]);
    }
  } catch {
    if (url) return { ...result, source_url: url, ...requestContext(image || element) };
    return { reason: "image_not_loaded", recovery: "Wait for the image to load, observe again, then collect its ref or a visible region." };
  }
  finally { clearTimeout(timer); }
  result.width = pixels.naturalWidth; result.height = pixels.naturalHeight;
  // Keep embedded raster bytes without a CSP-controlled fetch.
  const embedded = result.source_url.match(/^data:image\/(?:jpeg|png|gif|webp);base64,(.*)$/su);
  if (embedded && embedded[1].length <= 8 * 1024 * 1024 * 4 / 3
      && pixels.naturalWidth <= 16384 && pixels.naturalHeight <= 16384
      && pixels.naturalWidth * pixels.naturalHeight * 4 <= 128 * 1024 * 1024) {
    return { ...result, source_url: location.href, image: { data: embedded[1] } };
  }
  try {
    const canvas = document.createElement("canvas");
    const ratio = Math.min(1, 1280 / Math.max(pixels.naturalWidth, pixels.naturalHeight));
    canvas.width = Math.max(1, Math.round(pixels.naturalWidth * ratio));
    canvas.height = Math.max(1, Math.round(pixels.naturalHeight * ratio));
    canvas.getContext("2d").drawImage(pixels, 0, 0, canvas.width, canvas.height);
    result.pixel_ratio = 1;
    result.image = { data: canvas.toDataURL("image/png").split(",")[1] };
    if (/^(data|blob):/u.test(result.source_url)) result.source_url = location.href;
  } catch {
    // Cross-origin pixels can be captured by the host without relaxing CORS.
    result.capture_element = true;
    // A photo element's own file is the full original, whatever covers or shrinks
    // it on the page; the host downloads it with this page's request context and
    // keeps the rendered crop for when that download is unusable. A background
    // may be a sprite, so only its rendered crop represents it.
    if (image && /^https?:/u.test(result.source_url)) {
      Object.assign(result, { fetch_source: true }, requestContext(image, result.source_url));
    }
  }
  return result;
}

/** Isolated-world script shared by Electron and browser smokes. */
export function imageSourceScript(args) {
  return `(() => { const largestRendition = ${largestRendition.toString()}; return (${imageSource.toString()})(${JSON.stringify(args)}); })()`;
}
