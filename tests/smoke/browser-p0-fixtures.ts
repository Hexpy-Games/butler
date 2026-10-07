import { gpuHangFixture } from "./browser-p0-gpu-fixture.ts";
/** Entirely local browser workloads; no provider or public-site requests. */
export function browserP0Fixtures() {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/asset") return new Response(new Uint8Array(4096));
    const code = path === "/nodes" ? "for(let i=0;i<10000;i++){const e=document.createElement('div');e.dataset.node=i;e.textContent='노드 '+i;document.body.append(e)}"
      : path === "/cpu" ? "setInterval(()=>{const end=performance.now()+25;while(performance.now()<end)Math.sqrt(Math.random())},30)"
        : path === "/network" ? "setInterval(()=>{for(let i=0;i<40;i++)fetch('/asset?'+Math.random())},100)"
          : path === "/video" ? "const c=document.querySelector('canvas'),x=c.getContext('2d');function draw(){x.fillStyle='hsl('+performance.now()%360+',70%,50%)';x.fillRect(0,0,320,180);requestAnimationFrame(draw)}draw();const v=document.createElement('video');v.muted=true;v.loop=true;document.body.append(v);window.video=v;const chunks=[],r=new MediaRecorder(c.captureStream(30),{mimeType:'video/webm;codecs=vp8'});r.ondataavailable=e=>chunks.push(e.data);r.onstop=()=>{v.src=URL.createObjectURL(new Blob(chunks,{type:'video/webm'}));v.play()};r.start();setTimeout(()=>r.stop(),1000)"
            : path === "/gpu" ? gpuFixture(false) : path === "/hang" ? gpuFixture(true) : "";
    return new Response(`<!doctype html><meta charset="utf-8"><button onclick="this.dataset.clicks=Number(this.dataset.clicks||0)+1;this.textContent='Act '+this.dataset.clicks">Act</button><canvas width="320" height="180"></canvas><script>${code}</script>`, { headers: { "content-type": "text/html" } });
  } });
}

function gpuFixture(hang: boolean): string {
  if (hang) return gpuHangFixture;

  return "const c=document.querySelector('canvas');let n=0;function storm(){const gl=c.getContext('webgl');if(gl){const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,32768,32768,0,gl.RGBA,gl.UNSIGNED_BYTE,null);const loss=gl.getExtension('WEBGL_lose_context');loss?.loseContext();setTimeout(()=>loss?.restoreContext(),10);}n++;window.losses=n;}setInterval(storm,100);if(navigator.gpu)navigator.gpu.requestAdapter().then(a=>a?.requestDevice()).then(d=>d?.destroy());";
}
