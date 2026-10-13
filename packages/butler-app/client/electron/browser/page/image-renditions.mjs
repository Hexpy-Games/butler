/** Pick the largest loadable rendition explicitly attached to one image. */
export async function largestRendition(image, pixels) {
  if (!image) return pixels;
  // Only renditions explicitly attached to this element; never rewrite a URL.
  const renditions = [image.src, image.dataset.src, image.dataset.original, image.dataset.zoomImage,
    image.getAttribute("data-large-image"),
    ...[image, ...image.closest("picture")?.querySelectorAll("source") ?? []].flatMap(node =>
      (node.getAttribute("srcset") || "").split(/,\s*(?![^()]*\))/u).map(entry => entry.trim().split(/\s+/u)[0])),
    ...[image.closest("a")].filter(link => link && (/\.(?:png|jpe?g|webp|avif|gif)(?:[?#]|$)/iu.test(link.href)
      || link.type.startsWith("image/"))).map(link => link.href)];
  // At most eight candidates, loaded four at a time, each for at most 2 s.
  const sources = [...new Set(renditions)]
    .filter(candidate => candidate && candidate !== pixels?.src && candidate !== image.currentSrc).slice(0, 8);
  const area = node => (node?.naturalWidth || 0) * (node?.naturalHeight || 0);
  // The collected copy is at most 1280 px on its long side; larger renditions add nothing.
  const enough = node => Math.max(node?.naturalWidth || 0, node?.naturalHeight || 0) >= 1280;
  const load = candidate => new Promise(resolve => {
    const rendition = new Image();
    const done = loaded => {
      clearTimeout(deadline);
      rendition.onload = rendition.onerror = null;
      if (!loaded) rendition.src = "";
      resolve(loaded ? rendition : null);
    };
    const deadline = setTimeout(() => done(false), 2000);
    rendition.onload = () => done(true);
    rendition.onerror = () => done(false);
    rendition.referrerPolicy = image.referrerPolicy;
    rendition.src = candidate;
  });
  for (let start = 0; start < sources.length && !enough(pixels); start += 4) {
    for (const rendition of await Promise.all(sources.slice(start, start + 4).map(load))) {
      // The same decode bounds as embedded images: 16384 px a side and 128 MiB of pixels.
      if (rendition && rendition.naturalWidth <= 16384 && rendition.naturalHeight <= 16384
          && area(rendition) * 4 <= 128 * 1024 * 1024 && area(rendition) > area(pixels)) pixels = rendition;
    }
  }
  return pixels;
}
