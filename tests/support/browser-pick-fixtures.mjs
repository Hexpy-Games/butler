/** Offline real-world page patterns for browser element picking (no network). */
const swatch = (color, width = 320, height = 180) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${color}"/><circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) / 4}" fill="white"/></svg>`)}`;
const base = "<!doctype html><meta charset=utf-8><style>body{margin:0;padding:24px;font:16px/1.5 system-ui;color:#1d2433;background:#f6f7fb}" +
  ".card{position:relative;background:white;border:1px solid #d8dce6;border-radius:12px;padding:16px;box-shadow:0 2px 6px #0002}" +
  "button{font:inherit;padding:8px 16px;border-radius:8px;border:1px solid #889;background:#eef}</style>";
const page = (title, body) => `${base}<title>${title}</title>${body}<script>window.__ready=true</script>`;
const q = selector => `document.querySelector(${JSON.stringify(selector)})`;

export const pages = {
  modal: page("Role dialog", `<main><h1>Behind the modal</h1><p>Background article text that stays dimmed.</p></main>
    <div class="backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center">
      <div role="dialog" aria-modal="true" aria-labelledby="dlg-title" id="dlg" style="background:white;border-radius:12px;padding:24px;width:420px;box-shadow:0 8px 32px #0006">
        <h2 id="dlg-title" style="margin-top:0">Subscribe</h2><p id="dlg-text">Get product updates every week in your inbox.</p>
        <label>Email <input id="email" type="email" value="me@example.com"></label>
        <p>Password <input id="pw" type="password" value="hunter2"></p>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px"><button>Cancel</button><button>Subscribe</button></div>
      </div></div>`),
  // Portal-style modal (MUI/Radix): a transparent full-screen container above a sibling backdrop.
  portal: page("Portal dialog", `<main><h1>Portal behind</h1><p>Text.</p></main>
    <div style="position:fixed;inset:0;z-index:10"><div class="bd" style="position:fixed;inset:0;background:rgba(0,0,0,.5)"></div>
      <div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center">
        <section role="dialog" id="pdlg" style="background:white;padding:28px;border-radius:8px;width:380px"><h2>Portal title</h2><p id="ptext">Portal body copy.</p><textarea id="note">private note</textarea></section></div></div>`),
  native: page("Native dialog", `<h1>Native dialog page</h1><p>Behind.</p>
    <dialog id="nd" style="padding:24px;border:0;border-radius:12px;width:360px"><form method="dialog"><h2>Native</h2><p id="ndp">A native modal dialog.</p><input value="native value"><button>OK</button></form></dialog>
    <script>nd.showModal()</script>`),
  cards: page("Cards", `<style>.grid{display:grid;grid-template-columns:repeat(3,280px);gap:20px}.card img{display:block;width:100%;height:140px;object-fit:cover;border-radius:8px}
    .stretched::after{content:"";position:absolute;inset:0}</style>
    <div class="grid">${[1, 2, 3].map(n => `<article class="card" id="card${n}"><img id="img${n}" src="${swatch(["#4b7bec", "#20bf6b", "#fa8231"][n - 1])}" alt="Cover ${n}"><h3 id="title${n}">Card title ${n}</h3><p id="desc${n}">Short description for card ${n}.</p><a class="stretched" href="#c${n}">Read more</a></article>`).join("")}</div>`),
  list: page("List", `<style>ul{list-style:none;padding:0;width:640px}li{padding:12px 16px;border-bottom:1px solid #ccd;background:white}li a{display:block;color:#1a0dab;text-decoration:none}small{color:#555}</style>
    <ul>${[1, 2, 3, 4].map(n => `<li id="li${n}"><a href="#r${n}"><span id="lt${n}">Search result title ${n}</span><br><small>example.com/result/${n}</small></a><p id="ls${n}" style="margin:4px 0 0">Snippet text for result number ${n}.</p></li>`).join("")}</ul>`),
  figure: page("Figure", `<figure id="fig" style="margin:0;width:360px;background:white;padding:12px"><img id="figimg" src="${swatch("#8854d0", 336, 200)}" alt="Chart preview" style="display:block"><figcaption id="figcap">Figure 1. Revenue by quarter.</figcaption></figure>`),
  media: page("Media", `<div id="player" style="position:relative;width:480px;height:270px"><video id="vid" width="480" height="270" poster="${swatch("#222", 480, 270)}" style="display:block"></video>
    <div class="controls" style="position:absolute;inset:0"><button style="position:absolute;left:12px;bottom:12px">Play</button></div></div>
    <canvas id="cv" width="300" height="120" style="margin-top:16px;display:block"></canvas>
    <script>const c=cv.getContext("2d");c.fillStyle="#eb3b5a";c.fillRect(0,0,300,120);c.fillStyle="white";c.font="32px sans-serif";c.fillText("Canvas",80,72)</script>`),
  svg: page("SVG", `<div id="toolbar" style="display:flex;gap:8px;padding:8px;background:white;width:max-content"><button id="iconbtn" aria-label="Settings" style="padding:8px;line-height:0"><svg id="icon" width="16" height="16" viewBox="0 0 16 16"><path id="iconpath" d="M2 2h12v12H2z" fill="#333"/></svg></button><button>Text button</button></div>
    <svg id="chart" width="400" height="200" style="display:block;margin-top:24px;background:white">${[40, 120, 80, 160].map((h, i) => `<rect class="bar" id="bar${i}" x="${20 + i * 95}" y="${200 - h}" width="70" height="${h}" fill="#3867d6"/>`).join("")}</svg>`),
  text: page("Text", "<article style=\"width:600px\"><h2 id=\"h\">Article heading</h2><p id=\"para\">Some <strong id=\"strong\">bold words</strong> sit beside a <a href=\"#x\" id=\"link\">link</a> inside a long paragraph that wraps across lines so that a range of text can be captured by dragging an area over part of it.</p><p id=\"para2\">Second paragraph text.</p></article>"),
  table: page("Table", `<table id="tbl" style="border-collapse:collapse;background:white"><thead><tr><th>Name</th><th>Qty</th><th>Price</th></tr></thead><tbody>${[1, 2, 3].map(n => `<tr id="tr${n}"><td id="td${n}" style="padding:8px 24px;border:1px solid #ccd">Item ${n}</td><td style="padding:8px 24px;border:1px solid #ccd">${n * 3}</td><td style="padding:8px 24px;border:1px solid #ccd">$${n * 10}</td></tr>`).join("")}</tbody></table>`),
  overlay: page("Overlays", `<div style="position:relative;width:320px;height:180px"><img id="ovimg" src="${swatch("#0fb9b1")}" alt="Shielded"><div class="shield" style="position:absolute;inset:0"></div></div>
    <nav id="nav" style="display:flex;gap:12px;margin-top:24px;padding:12px;background:white;width:max-content"><a id="dis" href="#d" style="pointer-events:none;opacity:.5;padding:6px 12px;border:1px solid #99a;border-radius:6px">Disabled link</a><a href="#ok" style="padding:6px 12px">Enabled</a></nav>
    <p id="under" style="margin-top:24px;width:500px">Text under a pointer-events:none watermark layer.</p>
    <div class="card" id="pecard" style="margin-top:12px;width:300px"><img id="peimg" src="${swatch("#f7b731", 268, 100)}" style="pointer-events:none;display:block" alt="Decorative"><p>Card with a pointer-events:none image.</p></div>
    <div style="position:fixed;inset:0;pointer-events:none;background:rgba(255,0,0,.03)"></div>`),
  shadow: page("Shadow DOM", `<x-open id="open"></x-open><x-closed id="closed" style="display:block;margin-top:16px"></x-closed>
    <script>const o=document.getElementById("open").attachShadow({mode:"open"});o.innerHTML='<style>.card{background:white;border:1px solid #ccd;border-radius:12px;padding:16px;width:300px}</style><div class="card" id="sc"><h3 id="sh">Shadow card</h3><p>Inside an open shadow root.</p></div>';
    const c=document.getElementById("closed").attachShadow({mode:"closed"});c.innerHTML='<div style="background:#fff3;border:1px solid #c88;padding:16px;width:300px"><h3>Closed card</h3><p>Inside a closed shadow root.</p></div>';</script>`),
  frames: (other) => page("Frames", `<h1>Frames</h1><iframe name="same" src="/frame-card" style="width:360px;height:220px;border:2px solid #999"></iframe>
    <iframe name="cross" src="${other}/frame-card" style="width:360px;height:220px;border:2px solid #999;margin-left:16px"></iframe>`),
  // The real App run: a cross-site framed card beside a text run for an area.
  mix: (other) => page("Pick mix", `<h1>Pick mix</h1><iframe name="cross" src="${other}/frame-card" style="width:360px;height:220px;border:2px solid #999"></iframe>
    <p id="para" style="width:600px">Some <strong id="strong">bold words</strong> sit beside a <a href="#x" id="link">link</a> inside a paragraph for an area capture.</p>`),
  "frame-card": page("Frame card", "<div class=\"card\" id=\"fc\" style=\"width:280px\"><h3 id=\"fh\">Framed card</h3><p id=\"fp\">Text inside the frame.</p><input id=\"fi\" value=\"framed secret\"></div>"),
  sticky: page("Sticky", `<header id="hdr" style="position:sticky;top:0;background:#223;color:white;padding:12px 24px;margin:-24px -24px 0">Sticky header <nav style="display:inline">Home · Docs</nav></header>
    <div style="height:2400px;padding-top:24px"><p id="sp">Scrolled content paragraph.</p></div><script>scrollTo(0,400)</script>`),
  disabled: page("Disabled", `<form id="form" style="background:white;padding:16px;width:420px"><button id="dbtn" type="button" disabled>Disabled button</button> <input id="dinp" disabled value="disabled value">
    <fieldset id="fs" disabled style="margin-top:12px"><legend>Disabled group</legend><input value="x"> <button type="button">Inner</button></fieldset></form>`),
  scroll: page("Scroll container", `<ul id="box" style="list-style:none;margin:0;padding:0;height:200px;width:320px;overflow:auto;background:white;border:1px solid #99a">${Array.from({ length: 20 }, (_, n) => `<li id="it${n}" style="height:60px;border-bottom:1px solid #ddd;padding:8px;box-sizing:border-box">Row ${n}</li>`).join("")}</ul>
    <script>box.scrollTop=150</script>`),
  sizes: page("Sizes", `<p id="dotline">Status <span id="dot" style="display:inline-block;width:6px;height:6px;border-radius:3px;background:red"></span> online</p>
    <section id="huge" style="height:3000px;background:#e9edff;padding:16px"><p>Very tall section.</p></section>`),
  form: page("Form card", `<div class="card" id="searchcard" style="width:420px"><h3 id="sch">Search the docs</h3><input id="q" value="typed private query" style="width:300px"> <button>Go</button></div>
    <div id="editor" contenteditable="true" style="margin-top:16px;background:white;padding:12px;width:400px;border:1px solid #ccd"><p id="ep">Editable paragraph text.</p></div>`),
};

const at = (frames, el, fx = 0.5, fy = 0.5, dx = 0, dy = 0) => ({ frames, el, fx, fy, dx, dy });
/** target: the element a person means; steps: ↑ presses allowed (0 = must be the default). */
export const cases = [
  { id: "modal-padding", page: "modal", at: at([], q("#dlg"), 0, 0, 8, 8), target: { frames: [], el: q("#dlg") }, steps: 0 },
  { id: "modal-backdrop", page: "modal", at: { x: 30, y: 30 }, target: { frames: [], el: q("#dlg") }, steps: 0 },
  { id: "modal-backdrop-text", page: "modal", at: at([], q("main h1"), 0.05, 0.5), target: { frames: [], el: q("#dlg") }, steps: 0 },
  { id: "modal-text-up", page: "modal", at: at([], q("#dlg-text")), target: { frames: [], el: q("#dlg") }, steps: 3, secret: ["me@example.com", "hunter2"], masks: ["#email", "#pw"] },
  { id: "modal-text", page: "modal", at: at([], q("#dlg-text")), target: { frames: [], el: q("#dlg-text") }, steps: 0 },
  { id: "portal-backdrop", page: "portal", at: { x: 30, y: 30 }, target: { frames: [], el: q("#pdlg") }, steps: 0, secret: ["private note"], masks: ["#note"] },
  { id: "portal-padding", page: "portal", at: at([], q("#pdlg"), 0, 1, 8, -6), target: { frames: [], el: q("#pdlg") }, steps: 0 },
  { id: "native-padding", page: "native", at: at([], q("#nd"), 0, 0, 6, 6), target: { frames: [], el: q("#nd") }, steps: 0, secret: ["native value"], masks: ["#nd input"] },
  { id: "native-backdrop", page: "native", at: { x: 30, y: 30 }, target: { frames: [], el: q("#nd") }, steps: 0 },
  { id: "card-title", page: "cards", at: at([], q("#title2")), target: { frames: [], el: q("#title2") }, steps: 0 },
  { id: "card-whole", page: "cards", at: at([], q("#title2")), target: { frames: [], el: q("#card2") }, steps: 1 },
  { id: "card-image", page: "cards", at: at([], q("#img1")), target: { frames: [], el: q("#img1") }, steps: 0 },
  { id: "list-item", page: "list", at: at([], q("#lt2")), target: { frames: [], el: q("#li2") }, steps: 2 },
  { id: "figure-img", page: "figure", at: at([], q("#figimg")), target: { frames: [], el: q("#fig") }, steps: 0 },
  { id: "figure-only-img", page: "figure", at: at([], q("#figimg")), target: { frames: [], el: q("#figimg") }, steps: -1 },
  { id: "video-overlay", page: "media", at: at([], q("#vid"), 0.6, 0.4), target: { frames: [], el: q("#vid") }, steps: 0 },
  { id: "canvas", page: "media", at: at([], q("#cv")), target: { frames: [], el: q("#cv") }, steps: 0 },
  { id: "svg-icon", page: "svg", at: at([], q("#iconpath")), target: { frames: [], el: q("#iconbtn") }, steps: 0 },
  { id: "svg-chart", page: "svg", at: at([], q("#bar3")), target: { frames: [], el: q("#chart") }, steps: 0 },
  { id: "svg-bar", page: "svg", at: at([], q("#bar3")), target: { frames: [], el: q("#bar3") }, steps: -1 },
  { id: "text-inline", page: "text", at: at([], q("#strong")), target: { frames: [], el: q("#para") }, steps: 0 },
  { id: "table-cell", page: "table", at: at([], q("#td2")), target: { frames: [], el: q("#td2") }, steps: 0 },
  { id: "table-row", page: "table", at: at([], q("#td2")), target: { frames: [], el: q("#tr2") }, steps: 1 },
  { id: "transparent-overlay", page: "overlay", at: at([], q("#ovimg")), target: { frames: [], el: q("#ovimg") }, steps: 0 },
  { id: "pe-none-link", page: "overlay", at: at([], q("#dis")), target: { frames: [], el: q("#dis") }, steps: 0 },
  { id: "pe-none-layer", page: "overlay", at: at([], q("#under"), 0.2), target: { frames: [], el: q("#under") }, steps: 0 },
  { id: "pe-none-image", page: "overlay", at: at([], q("#peimg")), target: { frames: [], el: q("#peimg") }, steps: 0 },
  { id: "shadow-open", page: "shadow", at: at([], `${q("#open")}.shadowRoot.querySelector("#sh")`), target: { frames: [], el: `${q("#open")}.shadowRoot.querySelector("#sc")` }, steps: 1 },
  { id: "shadow-closed", page: "shadow", at: at([], q("#closed")), target: { frames: [], el: q("#closed") }, steps: 0 },
  { id: "iframe-same", page: "frames", at: at(["same"], q("#fh")), target: { frames: ["same"], el: q("#fc") }, steps: 1, secret: ["framed secret"], masks: ["#fi"] },
  { id: "iframe-cross", page: "frames", at: at(["cross"], q("#fh")), target: { frames: ["cross"], el: q("#fc") }, steps: 1, secret: ["framed secret"], masks: ["#fi"] },
  { id: "iframe-whole", page: "frames", at: at(["cross"], q("#fh")), target: { frames: [], el: q('iframe[name="cross"]') }, steps: 3 },
  { id: "sticky-header", page: "sticky", at: at([], q("#hdr"), 0.05), target: { frames: [], el: q("#hdr") }, steps: 0 },
  { id: "disabled-button", page: "disabled", at: at([], q("#dbtn")), target: { frames: [], el: q("#dbtn") }, steps: 0 },
  { id: "disabled-input", page: "disabled", at: at([], q("#dinp")), target: { frames: [], el: q("#dinp") }, steps: 0 },
  { id: "disabled-fieldset", page: "disabled", at: at([], q("#fs legend")), target: { frames: [], el: q("#fs") }, steps: 1 },
  { id: "scroll-item", page: "scroll", at: at([], q("#it4")), target: { frames: [], el: q("#it4") }, steps: 0 },
  { id: "scroll-clipped", page: "scroll", at: at([], q("#box"), 0.5, 0, 0, 3), target: { frames: [], el: q("#it2"), clip: q("#box") }, steps: 0 },
  { id: "huge-section", page: "sizes", at: at([], q("#huge"), 0.5, 0.2), target: { frames: [], el: q("#huge") }, steps: 0 },
  { id: "tiny-dot", page: "sizes", at: at([], q("#dot")), target: { frames: [], el: q("#dot") }, steps: -1 },
  { id: "form-card", page: "form", at: at([], q("#sch")), target: { frames: [], el: q("#searchcard") }, steps: 1, secret: ["typed private query"], masks: ["#q"] },
  { id: "editable", page: "form", at: at([], q("#ep")), target: { frames: [], el: q("#ep") }, steps: 0 },
  { id: "editor", page: "form", at: at([], q("#ep")), target: { frames: [], el: q("#editor") }, steps: 1 },
];

/** Area (drag-rectangle) captures: rect in page CSS pixels from a start/end point. */
export const areas = [
  { id: "area-text-run", page: "text", from: at([], q("#strong"), 0, 0.5, -2, -8), to: at([], q("#link"), 1, 0.5, 2, 8), contains: ["bold words", "link"], excludes: ["Second paragraph", "Article heading"] },
  { id: "area-cards", page: "cards", from: at([], q("#card1"), 0, 0, -8, -8), to: at([], q("#card2"), 1, 1, 8, 8), contains: ["Card title 1", "Card title 2"], excludes: ["Card title 3"], within: 2 },
  { id: "area-modal-form", page: "modal", from: at([], q("#dlg"), 0, 0, -4, -4), to: at([], q("#dlg"), 1, 1, 4, 4), contains: ["Subscribe"], excludes: ["me@example.com", "hunter2"], masks: ["#email", "#pw"] },
];
