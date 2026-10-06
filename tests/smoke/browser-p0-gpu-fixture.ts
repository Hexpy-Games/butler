/** Finite, timestamped GPU work. No busy JS loop and no submission-time proxy. */
export const gpuHangFixture = `
window.prepare=async()=>{
  const adapter=await navigator.gpu?.requestAdapter();
  if(!adapter)return {blocked:true};
  if(!adapter.features.has('timestamp-query'))throw Error('GPU timestamps unavailable');
  const d=await adapter.requestDevice({requiredFeatures:['timestamp-query']});
  const state=window.p0GpuState={errors:[],lostReason:null,pending:false};
  d.addEventListener('uncapturederror',e=>state.errors.push(e.error.message));
  d.lost.then(x=>{state.lostReason=x.reason;});
  const output=d.createBuffer({size:16777216,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
  const read=d.createBuffer({size:16777216,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  const queries=d.createQuerySet({type:'timestamp',count:2});
  const resolved=d.createBuffer({size:256,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC});
  const stamps=d.createBuffer({size:16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  const shader=d.createShaderModule({code:
    '@group(0) @binding(0) var<storage,read_write> out:array<u32>; @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){var x=id.x+1u;for(var i=0u;i<1000000u;i++){x=(x*1664525u+1013904223u)^(x>>13u);}out[id.x]=x;}'});
  const compilation=await shader.getCompilationInfo();
  if(compilation.messages.some(m=>m.type==='error'))throw Error('Shader compilation failed');
  const pipeline=await d.createComputePipelineAsync({layout:'auto',compute:{module:shader,entryPoint:'main'}});
  const group=d.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:output}}]});
  async function work(groups){
    const encoder=d.createCommandEncoder();
    const pass=encoder.beginComputePass({timestampWrites:{querySet:queries,beginningOfPassWriteIndex:0,endOfPassWriteIndex:1}});
    pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(groups);pass.end();
    encoder.resolveQuerySet(queries,0,2,resolved,0);encoder.copyBufferToBuffer(resolved,0,stamps,0,16);
    encoder.copyBufferToBuffer(output,0,read,0,groups*64*4);
    const started=performance.now();state.pending=true;d.queue.submit([encoder.finish()]);
    await d.queue.onSubmittedWorkDone();await stamps.mapAsync(GPUMapMode.READ);await read.mapAsync(GPUMapMode.READ,0,groups*64*4);
    const times=new BigUint64Array(stamps.getMappedRange());
    const gpuMs=Number(times[1]-times[0])/1e6;
    const values=new Uint32Array(read.getMappedRange(0,groups*64*4));
    let x=1;for(let i=0;i<1000000;i++)x=((Math.imul(x,1664525)+1013904223)>>>0)^(x>>>13);
    const correct=values[0]===(x>>>0)&&values.length===groups*64&&values.every(v=>v!==0);
    const result={gpuMs,fenceMs:performance.now()-started,completed:values.length,groups,correct,errors:[...state.errors],lostReason:state.lostReason};
    stamps.unmap();read.unmap();state.pending=false;return result;
  }
  await work(128);
  const calibration=await work(2048);
  if(!calibration.correct||calibration.gpuMs<=0)throw Error('GPU calibration incorrect');
  // A single measured dispatch must span >=2 s; calibration is not proof of stall.
  const groups=Math.min(65535,Math.max(2048,Math.ceil(2048*4000/calibration.gpuMs)));
  window.stall=()=>work(groups);
  return {blocked:false,calibration,groups,fixtureRevision:"timestamp-v2"};
};`;
