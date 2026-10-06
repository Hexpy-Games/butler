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
    return new Response(`<!doctype html><meta charset="utf-8"><button onclick="this.dataset.clicks=Number(this.dataset.clicks||0)+1">Act</button><canvas width="320" height="180"></canvas><script>${code}</script>`, { headers: { "content-type": "text/html" } });
  } });
}

function gpuFixture(hang: boolean): string {
  if (hang) return `window.prepare=async()=>{
    const a=await navigator.gpu?.requestAdapter();if(!a)throw Error('WebGPU adapter unavailable');
    const d=await a.requestDevice();const errors=[];window.p0GpuState={errors,lostReason:null};d.addEventListener('uncapturederror',e=>errors.push(e.error.message));let lostReason=null;d.lost.then(x=>{lostReason=x.reason;window.p0GpuState.lostReason=x.reason});const b=d.createBuffer({size:12,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC}),r=d.createBuffer({size:12,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    const m=d.createShaderModule({code:'@group(0) @binding(0) var<storage,read_write> out:array<atomic<u32>>; @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){var x=id.x+1u;for(var i=0u;i<1000000000u;i++){x=atomicAdd(&out[0],x*1664525u+1013904223u);atomicAdd(&out[1],1u);}atomicAdd(&out[2],1u);}'});
    const p=await d.createComputePipelineAsync({layout:'auto',compute:{module:m,entryPoint:'main'}});
    const g=d.createBindGroup({layout:p.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:b}}]});
    window.stall=async()=>{const e=d.createCommandEncoder(),c=e.beginComputePass();c.setPipeline(p);c.setBindGroup(0,g);c.dispatchWorkgroups(256);c.end();e.copyBufferToBuffer(b,0,r,0,12);
      const start=performance.now();d.queue.submit([e.finish()]);
      const result=await Promise.race([d.queue.onSubmittedWorkDone().then(()=>({lost:false}),()=>({lost:true})),d.lost.then(x=>({lost:true,reason:x.reason}))]);
      const durationMs=performance.now()-start;let completed=null,iterations=null;if(!result.lost){await r.mapAsync(GPUMapMode.READ);const v=new Uint32Array(r.getMappedRange());iterations=v[1];completed=v[2];r.unmap();}
      return {durationMs,completed,iterations,errors,lostReason,...result,lost:result.lost||Boolean(lostReason)};};};`;

  return "const c=document.querySelector('canvas');let n=0;function storm(){const gl=c.getContext('webgl');if(gl){const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,32768,32768,0,gl.RGBA,gl.UNSIGNED_BYTE,null);const loss=gl.getExtension('WEBGL_lose_context');loss?.loseContext();setTimeout(()=>loss?.restoreContext(),10);}n++;window.losses=n;}setInterval(storm,100);if(navigator.gpu)navigator.gpu.requestAdapter().then(a=>a?.requestDevice()).then(d=>d?.destroy());";
}
