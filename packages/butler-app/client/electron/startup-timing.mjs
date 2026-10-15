// Shared timing state without loading Electron API getters before ready.
const createdAt = process.getCreationTime();
const startedAt = createdAt === null ? null : performance.now() - (Date.now() - createdAt);
const events = [];
export function startupTimings() { return events.map((event) => ({ ...event })); }
export function startupTiming(stage) {
  const elapsed = startedAt === null ? null : performance.now() - startedAt;
  events.push({ stage, elapsed_ms: elapsed === null ? null : Number(elapsed.toFixed(3)), timestamp_ms: Date.now() });
  console.info(JSON.stringify({ startup: events.at(-1) }));
}
startupTiming("process_start");
