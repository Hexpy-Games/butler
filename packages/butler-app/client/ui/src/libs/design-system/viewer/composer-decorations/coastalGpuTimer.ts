interface TimerExtension { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }

/** Asynchronous GPU queries; never gl.finish/readPixels or a polling loop while paused. */
export function coastalGpuTimer(gl: WebGL2RenderingContext) {
  const extension = gl.getExtension("EXT_disjoint_timer_query_webgl2") as TimerExtension | null;
  const metrics = { gpuMs: 0, gpuSamples: 0, gpuAvailable: Boolean(extension) };
  let pending: WebGLQuery | null = null;
  let active: WebGLQuery | null = null;
  const reset = () => {
    if (pending) gl.deleteQuery(pending);
    if (active) gl.deleteQuery(active);
    pending = null; active = null;
    metrics.gpuMs = 0; metrics.gpuSamples = 0;
  };
  return { metrics, reset, begin() {
    if (!extension) return;
    if (gl.getParameter(extension.GPU_DISJOINT_EXT)) { reset(); return; }
    if (pending && gl.getQueryParameter(pending, gl.QUERY_RESULT_AVAILABLE)) {
      metrics.gpuMs += Number(gl.getQueryParameter(pending, gl.QUERY_RESULT)) / 1e6;
      metrics.gpuSamples += 1;
      gl.deleteQuery(pending); pending = null;
    }
    if (pending) return;
    active = gl.createQuery();
    if (active) gl.beginQuery(extension.TIME_ELAPSED_EXT, active);
  }, end() {
    if (!extension || !active) return;
    gl.endQuery(extension.TIME_ELAPSED_EXT);
    pending = active; active = null;
  }, dispose: reset };
}
