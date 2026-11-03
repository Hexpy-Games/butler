"""Generates the shared test content: 100 chat exchanges (markdown + equivalent static HTML) and the AI-made artifact.
usage: python3 -I gen_content.py <outdir>"""
import html, json, os, random, sys

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
rnd = random.Random(20261103)
TOPICS = ["SQLite WAL checkpoints", "Rust async cancellation", "React list virtualization", "CSS container queries",
          "Tokio spawn_blocking", "HTTP/2 flow control", "Git merge strategies", "Unicode normalization",
          "Electron process model", "WebKit content blockers", "Bloom filters", "LRU cache eviction"]
LANGS = {
    "rust": "use std::collections::HashMap;\n\npub fn tally(words: &[&str]) -> HashMap<String, usize> {\n    let mut counts = HashMap::new();\n    for w in words {\n        *counts.entry(w.to_lowercase()).or_insert(0) += 1;\n    }\n    counts\n}\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn counts_case_insensitively() {\n        let c = super::tally(&[\"A\", \"a\", \"b\"]);\n        assert_eq!(c[\"a\"], 2);\n    }\n}",
    "typescript": "export async function retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {\n  let last: unknown;\n  for (let i = 0; i < attempts; i++) {\n    try {\n      return await fn();\n    } catch (error) {\n      last = error;\n      await new Promise((r) => setTimeout(r, 2 ** i * 100));\n    }\n  }\n  throw last;\n}\n\nconst value = await retry(() => fetch('/api/items').then((r) => r.json()));\nconsole.log(value.length);",
    "python": "import sqlite3\nfrom contextlib import closing\n\ndef top_tags(db_path: str, limit: int = 10) -> list[tuple[str, int]]:\n    with closing(sqlite3.connect(db_path)) as db:\n        rows = db.execute(\n            \"SELECT tag, COUNT(*) AS n FROM tags GROUP BY tag ORDER BY n DESC LIMIT ?\",\n            (limit,),\n        ).fetchall()\n    return [(tag, n) for tag, n in rows]\n\nif __name__ == \"__main__\":\n    for tag, n in top_tags(\"notes.db\"):\n        print(f\"{tag:20} {n}\")",
}
KW = {"rust": ["use", "pub", "fn", "let", "mut", "for", "in", "mod", "assert_eq!"],
      "typescript": ["export", "async", "function", "let", "for", "try", "return", "await", "catch", "throw", "const", "new"],
      "python": ["import", "from", "def", "with", "as", "return", "for", "in", "if"]}
SENT = ["The short answer is that it depends on how often the data changes and who reads it.",
        "In practice the bottleneck is usually I/O rather than CPU, so measure before optimizing.",
        "Keep the hot path allocation-free and move the rare cases out of line.",
        "A common mistake is to hold a lock across an await point, which blocks other tasks.",
        "Prefer the simplest structure that keeps the invariant obvious to the next reader.",
        "This trades a little memory for predictable latency under load.",
        "If you need ordering guarantees, make them explicit instead of relying on timing."]


def answer(n):
    topic = TOPICS[n % len(TOPICS)]
    lang = list(LANGS)[n % 3]
    paras = [" ".join(rnd.sample(SENT, 3)) for _ in range(2)]
    items = [f"**Step {i+1}:** {rnd.choice(SENT)}" for i in range(4)]
    rows = [(f"option-{i}", f"{rnd.randint(1, 900)} ms", rnd.choice(["yes", "no", "partial"])) for i in range(4)]
    md = [f"## {topic} (reply {n})", "", paras[0], "", *[f"- {it}" for it in items], "", f"```{lang}", LANGS[lang], "```", "",
          "| Option | Latency | Safe |", "|---|---|---|", *[f"| `{a}` | {b} | {c} |" for a, b, c in rows], "", paras[1],
          "", f"> Note: see `{topic.lower().replace(' ', '_')}.md` for details."]
    return "\n".join(md), (topic, lang, paras, items, rows)


def code_html(lang, code):
    out = []
    for line in code.split("\n"):
        esc = html.escape(line)
        toks = []
        for tok in esc.split(" "):
            toks.append(f'<span class="kw">{tok}</span>' if tok in KW[lang] else (f'<span class="str">{tok}</span>' if tok.startswith(("&quot;", "'", "f&quot;")) else tok))
        out.append(f'<span class="line">{" ".join(toks)}</span>')
    return "\n".join(out)


def inline(s):
    s = html.escape(s)
    import re
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    return re.sub(r"`(.+?)`", r"<code>\1</code>", s)


answers, blocks = [], []
for n in range(1, 101):
    q = f"Q#{n}: Can you explain {TOPICS[n % len(TOPICS)]} with an example in {list(LANGS)[n % 3]}?"
    md, (topic, lang, paras, items, rows) = answer(n)
    answers.append({"n": n, "question": q, "markdown": md})
    tbl = "".join(f"<tr><td><code>{a}</code></td><td>{b}</td><td>{c}</td></tr>" for a, b, c in rows)
    blocks.append(f'''<div class="msg user"><div class="bubble">{html.escape(q)}</div></div>
<div class="msg assistant"><div class="body"><h2>{html.escape(topic)} (reply {n})</h2><p>{inline(paras[0])}</p>
<ul>{"".join(f"<li>{inline(i)}</li>" for i in items)}</ul>
<div class="codeblock"><div class="codehead"><span>{lang}</span><button>Copy</button></div><pre><code class="lang-{lang}">{code_html(lang, LANGS[lang])}</code></pre></div>
<table><thead><tr><th>Option</th><th>Latency</th><th>Safe</th></tr></thead><tbody>{tbl}</tbody></table>
<p>{inline(paras[1])}</p><blockquote>Note: see <code>{topic.lower().replace(" ", "_")}.md</code> for details.</blockquote></div>
<div class="footer"><time>12:{n % 60:02d}</time><button>Copy</button></div></div>''')

css = """:root{color-scheme:light dark;--bg:#fbfaf8;--fg:#1d1c1a;--muted:#6b6862;--card:#f1efeb;--code:#16161a;--kw:#c678dd;--str:#98c379}
@media (prefers-color-scheme:dark){:root{--bg:#1b1a19;--fg:#ecebe8;--muted:#a19d96;--card:#262523}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Pretendard",sans-serif;display:grid;grid-template-columns:260px 1fr;height:100vh}
nav{border-right:1px solid #0001;padding:16px;overflow:auto}nav a{display:block;padding:6px 8px;border-radius:8px;color:inherit;text-decoration:none}nav a:hover{background:var(--card)}
main{overflow:auto;padding:24px 0}.thread{max-width:760px;margin:0 auto;padding:0 24px}.msg{margin:20px 0}.user{display:flex;justify-content:flex-end}
.bubble{background:var(--card);padding:10px 14px;border-radius:12px;max-width:68%}.body h2{font-size:18px;margin:0 0 8px}
.codeblock{border-radius:10px;overflow:hidden;background:var(--code);color:#e6e6e6;margin:12px 0}.codehead{display:flex;justify-content:space-between;padding:6px 12px;font-size:12px;background:#ffffff10}
pre{margin:0;padding:12px;overflow:auto;font:13px/1.5 ui-monospace,Menlo,monospace}.line{display:block}.kw{color:var(--kw)}.str{color:var(--str)}
table{border-collapse:collapse;margin:10px 0}td,th{border:1px solid #8883;padding:4px 10px}blockquote{margin:8px 0;padding-left:12px;border-left:3px solid #8886;color:var(--muted)}
code{font-family:ui-monospace,Menlo,monospace;font-size:.9em}.footer{display:flex;gap:8px;color:var(--muted);font-size:12px}button{font:inherit;border:1px solid #8884;background:transparent;border-radius:6px;color:inherit}
.composer{position:sticky;bottom:0;max-width:760px;margin:0 auto;padding:12px 24px;background:linear-gradient(transparent,var(--bg) 30%)}.composer textarea{width:100%;height:72px;border-radius:12px;border:1px solid #8885;padding:10px;font:inherit;background:var(--bg);color:inherit}"""
nav = "".join(f'<a href="#">Chat {i}</a>' for i in range(1, 41))
page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Chat (100 exchanges)</title><style>{css}</style></head>
<body><nav>{nav}</nav><main><div class="thread">{"".join(blocks)}</div><div class="composer"><textarea placeholder="Message"></textarea></div></main>
<script>document.querySelector('main').scrollTop=1e9</script></body></html>"""
open(os.path.join(out, "chat.html"), "w").write(page)
json.dump(answers, open(os.path.join(out, "answers.json"), "w"))

artifact = r"""<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Orbit Garden</title>
<style>
:root{--bg:#0d1020;--fg:#e8ecff;--accent:#7aa2ff}*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif;overflow:hidden}
canvas{position:fixed;inset:0;width:100%;height:100%}
.panel{position:fixed;top:16px;left:16px;padding:14px 16px;border-radius:14px;background:#ffffff14;backdrop-filter:blur(12px);border:1px solid #ffffff22;width:260px}
.panel h1{font-size:16px;margin:0 0 8px}.row{display:flex;justify-content:space-between;align-items:center;margin:6px 0}
input[type=range]{width:130px}.pill{display:inline-block;padding:2px 8px;border-radius:99px;background:var(--accent);color:#0d1020;font-weight:600}
.ring{position:fixed;right:40px;bottom:40px;width:120px;height:120px;border-radius:50%;border:6px solid transparent;border-top-color:var(--accent);border-right-color:#ff7ab6;animation:spin 2.4s linear infinite}
.pulse{position:fixed;right:80px;bottom:80px;width:40px;height:40px;border-radius:50%;background:#ff7ab6;animation:pulse 1.6s ease-in-out infinite}
@keyframes spin{to{transform:rotate(360deg)}}@keyframes pulse{50%{transform:scale(1.5);opacity:.4}}
.list{max-height:160px;overflow:auto;margin-top:8px}.list div{padding:3px 6px;border-radius:6px;transition:background .3s}.list div:hover{background:#ffffff18}
</style></head><body>
<canvas id="c"></canvas>
<div class="panel"><h1>Orbit Garden <span class="pill" id="fps">0 fps</span></h1>
<div class="row"><label for="n">Particles</label><input id="n" type="range" min="100" max="3000" value="1500"></div>
<div class="row"><label for="s">Speed</label><input id="s" type="range" min="1" max="20" value="6"></div>
<div class="row"><span>Collisions</span><span id="hits">0</span></div>
<div class="list" id="log"></div></div>
<div class="ring"></div><div class="pulse"></div>
<script>
const c=document.getElementById('c'),x=c.getContext('2d');let W,H,ps=[],hits=0;
function size(){W=c.width=innerWidth*devicePixelRatio;H=c.height=innerHeight*devicePixelRatio}addEventListener('resize',size);size();
function make(n){ps=Array.from({length:n},(_,i)=>({a:Math.random()*6.283,r:40+Math.random()*Math.min(W,H)*.45,v:.002+Math.random()*.01,h:(i*37)%360,s:1+Math.random()*3}))}
make(1500);document.getElementById('n').oninput=e=>make(+e.target.value);
let last=performance.now(),frames=0,acc=0;const log=document.getElementById('log');
function frame(t){const dt=t-last;last=t;acc+=dt;frames++;if(acc>1000){document.getElementById('fps').textContent=frames+' fps';frames=0;acc=0;
 const d=document.createElement('div');d.textContent=new Date().toLocaleTimeString()+' · '+ps.length+' particles';log.prepend(d);while(log.children.length>50)log.lastChild.remove()}
 const sp=+document.getElementById('s').value;x.fillStyle='rgba(13,16,32,.25)';x.fillRect(0,0,W,H);
 for(const p of ps){p.a+=p.v*sp*.2;const px=W/2+Math.cos(p.a)*p.r,py=H/2+Math.sin(p.a*1.3)*p.r*.6;x.fillStyle=`hsl(${(p.h+t/20)%360} 80% 65%)`;x.beginPath();x.arc(px,py,p.s,0,6.283);x.fill();
  if(Math.abs(px-W/2)<2&&Math.abs(py-H/2)<2)hits++}
 document.getElementById('hits').textContent=hits;requestAnimationFrame(frame)}
requestAnimationFrame(frame);
</script></body></html>"""
open(os.path.join(out, "artifact.html"), "w").write(artifact)
print("ok", os.path.getsize(os.path.join(out, "chat.html")), os.path.getsize(os.path.join(out, "artifact.html")))
