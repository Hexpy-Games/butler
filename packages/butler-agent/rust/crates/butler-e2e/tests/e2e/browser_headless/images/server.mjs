const port = Number(process.argv[2]);
const jpeg = await Bun.file("photo.jpg").arrayBuffer();
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="#18a0c8"/></svg>';
// Registered previews strip cookies by contract; cookie protection is covered by the direct browser smoke.
const names = ["redirect", "lazy", "srcset", "background", "webp", "avif", "protected", "large", "svg"];
Bun.serve({ hostname: "127.0.0.1", port, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/redirect") return new Response(null, { status: 302, headers: { location: "/photo.jpg" } });
  if (path === "/protected" && !request.headers.get("referer")) return new Response("Hotlink denied", { status: 403 });
  if (["/photo.jpg", "/protected", "/large"].includes(path)) {
    const bytes = path === "/large" ? new Uint8Array(jpeg.byteLength + 9 * 1024 * 1024) : new Uint8Array(jpeg);
    if (path === "/large") bytes.set(new Uint8Array(jpeg));
    return new Response(bytes, { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=3600" } });
  }
  if (path === "/photo.svg") return new Response(svg, { headers: { "content-type": "image/svg+xml" } });
  if (["/photo.webp", "/photo.avif"].includes(path)) return new Response(Bun.file(path.slice(1)), { headers: { "content-type": `image/${path.split(".").at(-1)}` } });
  const sources = { redirect: "/redirect", lazy: "/photo.jpg", srcset: "/photo.jpg", webp: "/photo.webp", avif: "/photo.avif", protected: "/protected", large: "/large", svg: "/photo.svg" };
  const elements = names.map(name => name === "background" ? '<div role="img" aria-label="background" style="background-image:url(/photo.jpg)"></div>'
    : name === "lazy" ? '<img alt="lazy" loading="lazy" data-src="/photo.jpg">'
      : name === "srcset" ? '<img alt="srcset" src="/missing" srcset="/photo.jpg 1x">'
        : `<img referrerpolicy="origin" alt="${name}" src="${sources[name]}">`).join("");
  return new Response(`<!doctype html><meta charset=utf-8><title>Image sources</title><style>img,div[role=img]{display:inline-block;width:120px;height:100px}body{margin:0}</style>${elements}<script>document.querySelector('[data-src]').src=document.querySelector('[data-src]').dataset.src;</script>`, { headers: { "content-type": "text/html" } });
} });
