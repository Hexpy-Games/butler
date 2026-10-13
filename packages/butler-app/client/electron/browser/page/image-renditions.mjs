/** Pick the largest decoded rendition explicitly associated with one image. */
export async function largestRendition(image, pixels) {
  if (!image) return pixels;
  // Only renditions explicitly attached to this element; never rewrite a URL.
  const renditions = [image.src, image.dataset.src, image.dataset.original, image.dataset.zoomImage,
    image.getAttribute("data-large-image"),
    ...[image, ...image.closest("picture")?.querySelectorAll("source") ?? []].flatMap(node =>
      (node.getAttribute("srcset") || "").split(/,\s*(?![^()]*\))/u).map(entry => entry.trim().split(/\s+/u)[0])),
    ...[image.closest("a")].filter(link => link && (/\.(?:png|jpe?g|webp|avif|gif)(?:[?#]|$)/iu.test(link.href)
      || link.type.startsWith("image/"))).map(link => link.href)];
  const sources = [...new Set(renditions)].filter(candidate => candidate && candidate !== pixels?.src && candidate !== image.currentSrc);
  // Decode in small batches: one slow candidate cannot serialize every other source.
  for (let start = 0; start < sources.length; start += 4) {
    const decoded = await Promise.all(sources.slice(start, start + 4).map(async candidate => {
      const rendition = new Image();
      rendition.referrerPolicy = image.referrerPolicy;
      rendition.src = candidate;
      let deadline;
      try {
        await Promise.race([rendition.decode(), new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error("timeout")), 2000);
        })]);
        return rendition;
      } catch { return null; }
      finally { clearTimeout(deadline); }
    }));
    for (const rendition of decoded) {
      if (rendition && rendition.naturalWidth * rendition.naturalHeight > (pixels?.naturalWidth || 0) * (pixels?.naturalHeight || 0)) pixels = rendition;
    }
  }
  return pixels;
}
