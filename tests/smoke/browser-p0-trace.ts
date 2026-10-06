/** CPU uses thread-clock interval unions; nested trace slices aren't double-counted. */
type Event = { name: string; ph: string; ts: number; tts?: number; tdur?: number; dur?: number; pid: number; tid: number; args?: any };
export function traceProcessStats(events: Event[]) {
  const names = new Map<number, string>();
  for (const event of events) if (event.name === "process_name") names.set(event.pid, event.args?.name || "unknown");
  const range = events.filter(e => e.ph !== "M" && e.ts > 0).reduce((r, e) => [Math.min(r[0]!, e.ts), Math.max(r[1]!, e.ts)], [Infinity, -Infinity]);
  const durationUs = range[1]! - range[0]!;
  const result = [];
  for (const [pid, name] of names) {
    if (!/renderer|gpu/iu.test(name)) continue;
    const selected = events.filter(e => e.pid === pid);
    const threads = new Map<number, Array<[number, number]>>();
    for (const event of selected) if (event.ph === "X" && event.tts !== undefined && event.tdur !== undefined) {
      const intervals = threads.get(event.tid) || [];
      intervals.push([event.tts, event.tts + event.tdur]); threads.set(event.tid, intervals);
    }
    let cpuUs = 0;
    for (const intervals of threads.values()) cpuUs += unionLength(intervals);
    const dumps = selected.filter(e => e.ph === "v");
    const bytes = (field: string) => dumps.flatMap(e => {
      const value = e.args?.dumps?.process_totals?.[field];
      return typeof value === "string" ? [parseInt(value, 16)] : typeof value === "number" ? [value] : [];
    });
    const rss = bytes("resident_set_bytes"), footprint = bytes("private_footprint_bytes");
    result.push({ pid, name, cpuPercent: threads.size && durationUs > 0 ? cpuUs / durationUs * 100 : null,
      rssPeakMiB: rss.length ? Math.max(...rss) / 1048576 : null, privateFootprintPeakMiB: footprint.length ? Math.max(...footprint) / 1048576 : null, cpuSlices: [...threads.values()].reduce((n, v) => n + v.length, 0), memoryDumps: dumps.length });
  }
  return result;
}

function unionLength(intervals: Array<[number, number]>): number {
  intervals.sort((a, b) => a[0] - b[0]);
  let start = -Infinity, end = -Infinity, total = 0;
  for (const [a, b] of intervals) {
    if (a > end) { if (end > start) total += end - start; start = a; end = b; }
    else end = Math.max(end, b);
  }
  return total + (end > start ? end - start : 0);
}
