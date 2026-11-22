const inline = (s: string) => s.replaceAll("</script", "<\\/script");

export function pdfPage({ lib, worker, data, background }: { lib: string; worker: string; data: string; background: string }): string {
  return `<!doctype html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<style>body { margin: 0; background: ${background}; }
#pages { display: flex; flex-direction: column; gap: 8px; padding: 8px 0; }
canvas { display: block; width: 100%; }</style>
</head><body><div id="pages"></div>
<script id="worker" type="text/plain">${inline(worker)}</script>
<script type="module">${inline(lib)}
try {
  const { getDocument, GlobalWorkerOptions } = globalThis.pdfjsLib;
  GlobalWorkerOptions.workerPort = new Worker(URL.createObjectURL(new Blob([document.getElementById("worker").textContent], { type: "text/javascript" })), { type: "module" });
  const pdf = await getDocument({ data: Uint8Array.from(atob(${inline(JSON.stringify(data))}), (c) => c.charCodeAt(0)) }).promise;
  const observer = new IntersectionObserver(async (entries) => {
    try {
      for (const entry of entries) {
        const canvas = entry.target;
        if (!entry.isIntersecting || canvas.rendered) continue;
        const page = canvas.page, vp = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: (innerWidth * devicePixelRatio) / vp.width });
        canvas.width = viewport.width; canvas.height = viewport.height;
        canvas.rendered = true;
        observer.unobserve(canvas);
        await page.render({ canvas, viewport }).promise;
      }
    } catch { window.ReactNativeWebView.postMessage("pdf_failed"); }
  }, { rootMargin: "100% 0px" });
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n), vp = page.getViewport({ scale: 1 });
    const canvas = document.createElement("canvas");
    canvas.style.aspectRatio = vp.width + " / " + vp.height;
    canvas.page = page;
    document.getElementById("pages").append(canvas);
    observer.observe(canvas);
  }
} catch { window.ReactNativeWebView.postMessage("pdf_failed"); }
</script></body></html>`;
}
