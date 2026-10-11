/** Offline pages for scrap snapshots: webfonts, CSS variables, lists, tables, SVG, canvas, images, shadow DOM, frames. */
const fonts = "@font-face{font-family:'Fixture Plex';src:url(/fonts/regular.woff2) format('woff2');font-weight:400}" +
  "@font-face{font-family:'Fixture Plex';src:url(/fonts/semibold.woff2) format('woff2');font-weight:600}";
const base = `<!doctype html><meta charset=utf-8><style>${fonts}:root{--accent:#6c5ce7;--ink:#1d2433;--radius:14px;--pad:18px}` +
  "body{margin:0;padding:24px;font:16px/1.5 system-ui;color:var(--ink);background:#f6f7fb}" +
  ".card{position:relative;background:white;border:1px solid #d8dce6;border-radius:var(--radius);padding:var(--pad);box-shadow:0 2px 6px #0002}</style>";
const ready = "<script>document.fonts.ready.then(()=>Promise.all([...document.images].map(i=>i.decode().catch(()=>{})))).then(()=>{window.__ready=true})</script>";
const page = (title, body, head = "") => `${base}${head}<title>${title}</title>${body}${ready}`;
const q = selector => `document.querySelector(${JSON.stringify(selector)})`;

export const pages = {
  "card-font": page("Webfont card", `<style>.grid>.card{width:320px;background:linear-gradient(180deg,#fff,#f3f1ff);border-color:color-mix(in srgb,var(--accent) 35%,white)}
    .grid .card .title{font-family:'Fixture Plex',monospace;font-weight:600;color:var(--accent);font-size:20px;margin:0 0 8px}
    .card .title::before{content:"\\2605  ";color:#e17055}.card p{font-family:'Fixture Plex',monospace;margin:0}
    .tag{display:inline-block;background:var(--accent);color:white;border-radius:999px;padding:2px 10px;font-size:12px;margin-top:10px}
    .act{font:inherit;margin-left:8px;padding:4px 12px;border-radius:8px;border:1px solid #889;background:#eef}</style>
    <div class="grid"><article class="card" id="card"><h2 class="title">Webfont card</h2><p>Variables, nested selectors and a pseudo badge.</p>
    <span class="tag">New</span><button class="act" onclick="document.title='ran'">Act</button><a href="javascript:document.title='ran'" style="margin-left:8px">js</a>
    <form action="https://forms.example/post" style="display:inline"><input type="submit" value="Send"></form><script>window.inside=1</script></article></div>`),
  list: page("List", `<style>ol{width:420px;background:white;padding:12px 12px 12px 40px;border-radius:10px}ol li{padding:6px 0;border-bottom:1px solid #e3e5ee}
    ol li::marker{color:var(--accent);font-weight:700}ol li:nth-child(odd){background:#fafaff}.meta{color:#667;font-size:13px}</style>
    <ol start="3">${[1, 2, 3, 4].map(n => `<li id="li${n}"><strong>Result ${n}</strong> <span class="meta">example.com/${n}</span></li>`).join("")}</ol>`),
  table: page("Table", `<style>table{border-collapse:collapse;background:white;font-variant-numeric:tabular-nums}th,td{padding:8px 20px;border:1px solid #ccd;text-align:left}
    tbody tr:nth-child(even){background:#eef2ff}td.num{text-align:right;color:#0a7}</style>
    <table id="tbl"><thead><tr><th>Name</th><th>Qty</th><th>Price</th></tr></thead><tbody>${[1, 2, 3].map(n => `<tr id="tr${n}"><td>Item ${n}</td><td class="num">${n * 3}</td><td class="num">$${n * 10}.00</td></tr>`).join("")}</tbody></table>`),
  svg: page("SVG chart", `<svg width="0" height="0" style="position:absolute"><defs><linearGradient id="bars" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6c5ce7"/><stop offset="1" stop-color="#a29bfe"/></linearGradient></defs></svg>
    <style>.axis{stroke:#99a;stroke-width:1}.label{font:600 12px 'Fixture Plex',monospace;fill:#445}</style>
    <svg id="chart" width="420" height="220" viewBox="0 0 420 220" style="display:block;background:white;border-radius:12px">
    <line class="axis" x1="30" y1="190" x2="410" y2="190"/>${[60, 140, 100, 170].map((h, i) => `<rect x="${50 + i * 90}" y="${190 - h}" width="60" height="${h}" rx="6" fill="url(#bars)"/><text class="label" x="${80 + i * 90}" y="208" text-anchor="middle">Q${i + 1}</text>`).join("")}</svg>`),
  canvas: page("Canvas", `<div class="card" id="cvcard" style="width:340px"><h3 style="margin:0 0 8px">Canvas card</h3><canvas id="cv" width="300" height="120" style="display:block;border-radius:8px"></canvas></div>
    <script>const c=cv.getContext("2d");const g=c.createLinearGradient(0,0,300,0);g.addColorStop(0,"#eb3b5a");g.addColorStop(1,"#fa8231");c.fillStyle=g;c.fillRect(0,0,300,120);c.fillStyle="white";c.font="bold 32px sans-serif";c.fillText("Canvas",90,72)</script>`),
  images: (other) => page("Images", `<style>.hero{height:120px;border-radius:10px;background:url(/img/tile.png) 0 0/40px 40px repeat}.row{display:flex;gap:10px;margin-top:10px}.row img{display:block;width:96px;height:72px;object-fit:cover;border-radius:8px}</style>
    <div class="card" id="imgcard" style="width:420px"><div class="hero"></div><div class="row"><img src="/img/photo.png" alt="Photo"><img srcset="/img/small.png 1x, /img/photo.png 2x" alt="Srcset"><img src="/img/icon.svg" alt="Icon"><img src="${other}/img/photo.png" alt="Cross-site"></div></div>`),
  shadow: page("Shadow card", `<fixture-card id="host"><span slot="title">Slotted title</span><p>Slotted light DOM body text.</p></fixture-card>
    <script>customElements.define("fixture-card",class extends HTMLElement{constructor(){super();this.attachShadow({mode:"open"}).innerHTML=
    '<style>:host{display:block;width:320px}.box{background:#fff8e7;border:1px solid #e8c77a;border-radius:12px;padding:16px}::slotted([slot=title]){font:600 18px "Fixture Plex",monospace;color:#8a5a00}.foot{margin-top:8px;font-size:12px;color:#996}</style>'+
    '<div class="box"><slot name="title"></slot><slot></slot><div class="foot">Inside an open shadow root</div></div>'}})</script>`),
  frames: (other) => page("Frames", `<h1 style="margin:0 0 12px;font-size:22px">Frames</h1><iframe name="cross" src="${other}/frame-card" style="width:360px;height:240px;border:2px solid #999;border-radius:6px;background:white"></iframe>`),
  "frame-card": page("Frame card", `<div class="card" id="fc" style="width:280px"><h3 id="fh" style="margin:0 0 6px;font-family:'Fixture Plex',monospace">Framed card</h3><p style="margin:0 0 8px">Text inside a cross-site frame.</p>
    <input id="fi" value="framed secret" style="font:inherit;padding:6px;width:240px"></div>`),
  form: page("Form card", `<div class="card" id="formcard" style="width:400px"><h3 style="margin:0 0 8px">Sign in</h3><label>Email <input id="email" value="me@example.com" style="font:inherit;padding:6px"></label>
    <p style="margin:8px 0 0">Password <input id="pw" type="password" value="hunter2" style="font:inherit;padding:6px"></p><p style="margin:8px 0 0">Note <input id="empty" placeholder="Optional note" style="font:inherit;padding:6px"></p></div>`),
  area: page("Area", `<style>.cols{display:grid;grid-template-columns:repeat(2,260px);gap:16px}</style><p id="intro" style="width:560px;margin:0 0 12px">An area pick keeps <strong>exactly</strong> what the rectangle covers, clipped at its edges.</p>
    <div class="cols"><div class="card" id="a1"><h3 style="margin:0">Left card</h3><p style="margin:4px 0 0">Some text.</p></div><div class="card" id="a2"><h3 style="margin:0">Right card</h3><input id="apw" type="password" value="hunter2" style="font:inherit;padding:4px;width:180px"></div></div>`),
};

/** el: what is picked (frames: iframe names to walk); up: ↑ steps from the default level; masks: filled fields. */
export const cases = [
  { id: "webfont-card", page: "card-font", el: q("#card"), secret: [], scripts: true },
  { id: "list-item", page: "list", el: q("#li2") },
  { id: "table-row", page: "table", el: q("#tr2") },
  { id: "svg-chart", page: "svg", el: q("#chart") },
  { id: "canvas", page: "canvas", el: q("#cv") },
  { id: "canvas-card", page: "canvas", el: q("#cvcard") },
  { id: "image-card", page: "images", el: q("#imgcard") },
  { id: "shadow-card", page: "shadow", el: q("#host") },
  { id: "frame-card", page: "frames", frames: ["cross"], el: q("#fc"), secret: ["framed secret"], masks: [{ frames: ["cross"], el: q("#fi") }] },
  { id: "frame-whole", page: "frames", el: q('iframe[name="cross"]'), secret: ["framed secret"], masks: [{ frames: ["cross"], el: q("#fi") }] },
  { id: "form-card", page: "form", el: q("#formcard"), secret: ["me@example.com", "hunter2"], masks: [{ el: q("#email") }, { el: q("#pw") }] },
  { id: "area", page: "area", area: { from: q("#intro"), to: q("#a2"), inset: [180, 0, -60, -6] }, secret: ["hunter2"], masks: [{ el: q("#apw") }] },
];
